/*
 * voice-asr native worker: one resident NeMo-Speech.cpp recognizer driven over a private pipe protocol.
 *
 * Only the public C ABI (include/nemo_speech/asr.h) is used. Every native call runs on this single
 * thread, so a stream is never closed or destroyed while stream_next is executing. The parent passes
 * the command and reply pipe descriptors as arguments and starts the worker with stdin, stdout and
 * stderr on /dev/null, so native logging can never reach the IPC stream or the service logs.
 *
 * Frame (both directions): uint32 little-endian payload length, uint8 type, payload.
 *
 * A stream started with the interim flag answers each push with its provisional transcript when that
 * changed: the finals so far plus the native interim hypothesis of the current utterance. It is the
 * cache-aware decoder's own interim result from the next() drain that already follows every push;
 * nothing is decoded again.
 *
 * usage: voice-asr-worker COMMAND_FD REPLY_FD MODEL_PATH
 */
#include <nemo_speech/asr.h>

#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <unistd.h>

/* ------------------------------------------------------------------------- */
/* Protocol                                                                  */
/* ------------------------------------------------------------------------- */

enum {
    CMD_START  = 'S', /* payload: none, or one flags byte */
    CMD_PUSH   = 'P', /* payload: PCM16LE samples */
    CMD_FINISH = 'F',
    CMD_CLOSE  = 'C',
    CMD_QUIT   = 'Q',
};

enum {
    REPLY_READY   = 'R', /* payload: ABI version string */
    REPLY_OK      = 'O',
    REPLY_ACK     = 'A',
    REPLY_PARTIAL = 'I', /* an ACK whose payload is the changed provisional transcript, UTF-8 */
    REPLY_FINAL   = 'T', /* payload: UTF-8 transcript */
    REPLY_CLOSED  = 'D',
    REPLY_ERROR   = 'E', /* payload: one error byte */
};

enum {
    ERR_PROTOCOL     = 1,
    ERR_STATE        = 2,
    ERR_NATIVE       = 3,
    ERR_OUTPUT_LIMIT = 4,
    ERR_NO_FINAL     = 5,
};

/* START flags. */
#define START_INTERIM 0x01

#define MAX_PUSH_SAMPLES 16000
#define MAX_TEXT_UNITS   32000 /* UTF-16 code units, which also bounds code points */
#define MAX_TEXT_BYTES   (MAX_TEXT_UNITS * 4)
#define WARMUP_SAMPLES   (16000 * 4)
#define WARMUP_CHUNK     2560

static int g_command_fd = -1;
static int g_reply_fd   = -1;

static int read_full(int fd, void * buf, size_t n) {
    uint8_t * p = buf;
    while (n > 0) {
        ssize_t r = read(fd, p, n);
        if (r < 0 && errno == EINTR) {
            continue;
        }
        if (r <= 0) {
            return -1;
        }
        p += r;
        n -= (size_t) r;
    }
    return 0;
}

static void write_full_or_exit(const void * buf, size_t n) {
    const uint8_t * p = buf;
    while (n > 0) {
        ssize_t w = write(g_reply_fd, p, n);
        if (w < 0 && errno == EINTR) {
            continue;
        }
        if (w <= 0) {
            _exit(0); /* parent is gone */
        }
        p += w;
        n -= (size_t) w;
    }
}

static void reply(uint8_t type, const void * payload, uint32_t length) {
    uint8_t header[5] = { (uint8_t) length, (uint8_t) (length >> 8), (uint8_t) (length >> 16), (uint8_t) (length >> 24), type };
    write_full_or_exit(header, sizeof(header));
    if (length > 0) {
        write_full_or_exit(payload, length);
    }
}

static void reply_error(uint8_t code) {
    reply(REPLY_ERROR, &code, 1);
}

/* ------------------------------------------------------------------------- */
/* Stream state                                                              */
/* ------------------------------------------------------------------------- */

typedef struct {
    nemo_speech_asr_stream * stream;
    bool                     finished;
    bool                     overflow;
    bool                     interim;      /* report provisional transcripts (START_INTERIM) */
    bool                     provisional_changed;
    int                      finals_after_finish;
    size_t                   text_bytes;
    size_t                   text_units;   /* JavaScript string length: UTF-16 code units */
    size_t                   interim_bytes;
    size_t                   reported_bytes;
    /* Everything above is reset when a stream opens; the buffers below are reset by length. */
    char                     text[MAX_TEXT_BYTES + 1];
    char                     interim_text[MAX_TEXT_BYTES + 1]; /* the current utterance's interim hypothesis */
    char                     provisional[MAX_TEXT_BYTES + 1];  /* scratch: text, a space, interim */
    char                     reported[MAX_TEXT_BYTES + 1];     /* the provisional last sent */
} stream_state;

/* UTF-16 code units of a UTF-8 string: one per code point, two for 4-byte sequences (U+10000 and above). */
static size_t utf16_units(const char * s, size_t n) {
    size_t units = 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char) s[i];
        if ((c & 0xC0) != 0x80) {
            units += c >= 0xF0 ? 2 : 1;
        }
    }
    return units;
}

/* Append a final segment within MAX_TEXT_UNITS UTF-16 units and MAX_TEXT_BYTES bytes; flag overflow beyond. */
static void append_final(stream_state * st, const char * text) {
    size_t n = text ? strlen(text) : 0;
    if (n == 0 || st->overflow) {
        return;
    }
    size_t sep   = st->text_bytes > 0 ? 1 : 0;
    size_t units = utf16_units(text, n) + sep;
    if (st->text_units + units > MAX_TEXT_UNITS || st->text_bytes + sep + n > MAX_TEXT_BYTES) {
        st->overflow = true;
        return;
    }
    if (sep) {
        st->text[st->text_bytes++] = ' ';
    }
    memcpy(st->text + st->text_bytes, text, n);
    st->text_bytes += n;
    st->text_units += units;
    st->text[st->text_bytes] = '\0';
}

/* Keep the current utterance's interim hypothesis when it changed; one too large to report is skipped. */
static void note_interim(stream_state * st, const char * text) {
    text     = text ? text : "";
    size_t n = strlen(text);
    if (n > MAX_TEXT_BYTES || (n == st->interim_bytes && memcmp(st->interim_text, text, n) == 0)) {
        return;
    }
    memcpy(st->interim_text, text, n);
    st->interim_text[n]     = '\0';
    st->interim_bytes       = n;
    st->provisional_changed = true;
}

/* Drain stream_next until no result is available. Finals are accumulated; an interim result is kept
 * only for a stream that reports provisional text, and a final ends the utterance it belonged to. */
static int drain(stream_state * st, bool after_finish) {
    for (;;) {
        nemo_speech_asr_result * result = NULL;
        if (nemo_speech_asr_stream_next(st->stream, &result) != NEMO_SPEECH_ASR_OK) {
            return -1;
        }
        if (!result) {
            return 0;
        }
        if (nemo_speech_asr_result_is_final(result)) {
            if (nemo_speech_asr_result_alternative_count(result) > 0) {
                append_final(st, nemo_speech_asr_result_transcript(result, 0));
            }
            if (after_finish) {
                st->finals_after_finish++;
            }
            st->interim_bytes       = 0;
            st->provisional_changed = true;
        } else if (st->interim && !after_finish && nemo_speech_asr_result_alternative_count(result) > 0) {
            note_interim(st, nemo_speech_asr_result_transcript(result, 0));
        }
        nemo_speech_asr_result_destroy(result);
    }
}

static int open_stream(nemo_speech_asr_recognizer * recognizer, stream_state * st, bool interim) {
    nemo_speech_asr_recognition_options options = nemo_speech_asr_recognition_options_default();
    options.interim_results                     = true;
    options.enable_automatic_punctuation        = true;
    memset(st, 0, offsetof(stream_state, text));
    st->text[0]         = '\0';
    st->interim_text[0] = '\0';
    st->interim         = interim;
    return nemo_speech_asr_streaming_recognize(recognizer, &options, &st->stream) == NEMO_SPEECH_ASR_OK ? 0 : -1;
}

static void close_stream(stream_state * st) {
    if (st->stream) {
        nemo_speech_asr_stream_close(st->stream);
        st->stream = NULL;
    }
}

/* A disposable stream of generated silence so lazy graph setup happens before readiness. */
static int warm(nemo_speech_asr_recognizer * recognizer, stream_state * st) {
    static float silence[WARMUP_CHUNK];
    if (open_stream(recognizer, st, false) != 0) {
        return -1;
    }
    int rc = 0;
    for (int done = 0; done < WARMUP_SAMPLES && rc == 0; done += WARMUP_CHUNK) {
        rc = nemo_speech_asr_stream_push_f32(st->stream, silence, WARMUP_CHUNK, 16000) == NEMO_SPEECH_ASR_OK ? drain(st, false) : -1;
    }
    if (rc == 0) {
        rc = nemo_speech_asr_stream_finish(st->stream) == NEMO_SPEECH_ASR_OK ? drain(st, true) : -1;
    }
    /* Warmup counts only if native produced its explicit end-of-stream final; its text is discarded. */
    if (rc == 0 && st->finals_after_finish == 0) {
        rc = -1;
    }
    close_stream(st);
    return rc;
}

/* ------------------------------------------------------------------------- */
/* Command loop                                                              */
/* ------------------------------------------------------------------------- */

/*
 * Answer a push. A reporting stream whose provisional transcript changed, and still fits the
 * transcript caps, gets it as REPLY_PARTIAL; otherwise, and always for other streams, a plain ACK.
 */
static void acknowledge(stream_state * st) {
    if (!st->interim || !st->provisional_changed) {
        reply(REPLY_ACK, NULL, 0);
        return;
    }
    size_t sep = st->text_bytes > 0 && st->interim_bytes > 0 ? 1 : 0;
    size_t n   = st->text_bytes + sep + st->interim_bytes;
    if (n > MAX_TEXT_BYTES || st->text_units + sep + utf16_units(st->interim_text, st->interim_bytes) > MAX_TEXT_UNITS) {
        reply(REPLY_ACK, NULL, 0);
        return;
    }
    memcpy(st->provisional, st->text, st->text_bytes);
    if (sep) {
        st->provisional[st->text_bytes] = ' ';
    }
    memcpy(st->provisional + st->text_bytes + sep, st->interim_text, st->interim_bytes);
    st->provisional_changed = false;
    /* A final that ends an utterance usually repeats its last interim, leaving the text as it was. */
    if (n == st->reported_bytes && memcmp(st->provisional, st->reported, n) == 0) {
        reply(REPLY_ACK, NULL, 0);
        return;
    }
    memcpy(st->reported, st->provisional, n);
    st->reported_bytes = n;
    reply(REPLY_PARTIAL, st->provisional, (uint32_t) n);
}

static void handle_push(stream_state * st, const uint8_t * payload, uint32_t length) {
    static float samples[MAX_PUSH_SAMPLES];
    if (!st->stream || st->finished) {
        reply_error(ERR_STATE);
        return;
    }
    if (length == 0 || length % 2 != 0 || length / 2 > MAX_PUSH_SAMPLES) {
        reply_error(ERR_PROTOCOL);
        return;
    }
    size_t n = length / 2;
    for (size_t i = 0; i < n; i++) {
        int16_t v  = (int16_t) ((uint16_t) payload[2 * i] | ((uint16_t) payload[2 * i + 1] << 8));
        samples[i] = (float) v / 32768.0f;
    }
    if (nemo_speech_asr_stream_push_f32(st->stream, samples, n, 16000) != NEMO_SPEECH_ASR_OK || drain(st, false) != 0) {
        reply_error(ERR_NATIVE);
        return;
    }
    if (st->overflow) {
        reply_error(ERR_OUTPUT_LIMIT);
        return;
    }
    acknowledge(st);
}

static void handle_finish(stream_state * st) {
    if (!st->stream || st->finished) {
        reply_error(ERR_STATE);
        return;
    }
    st->finished = true;
    if (nemo_speech_asr_stream_finish(st->stream) != NEMO_SPEECH_ASR_OK || drain(st, true) != 0) {
        reply_error(ERR_NATIVE);
    } else if (st->overflow) {
        reply_error(ERR_OUTPUT_LIMIT);
    } else if (st->finals_after_finish == 0) {
        reply_error(ERR_NO_FINAL);
    } else {
        reply(REPLY_FINAL, st->text, (uint32_t) st->text_bytes);
    }
}

int main(int argc, char ** argv) {
    if (argc != 4) {
        return 2;
    }
    /* Die with the parent; if it already exited before prctl took effect, stop now. */
    const char * parent = getenv("VOICE_ASR_PARENT_PID");
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || !parent || getppid() != (pid_t) atol(parent)) {
        return 3;
    }
    /* No core dumps and no ptrace/procfs memory access, before the model or any audio is touched. */
    const struct rlimit no_core = { 0, 0 };
    if (setrlimit(RLIMIT_CORE, &no_core) != 0 || prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0 ||
        prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0) {
        return 5;
    }
    signal(SIGPIPE, SIG_IGN);
    g_command_fd = atoi(argv[1]);
    g_reply_fd   = atoi(argv[2]);

    nemo_speech_asr_backend_config   backend   = { sizeof(backend), -1 };
    nemo_speech_asr_model_config     model     = { sizeof(model), argv[3], NULL };
    /* CTC-only fields carry the library defaults (src/asr/runner.h); right context 1 = 160 ms chunks. */
    nemo_speech_asr_streaming_config streaming = { sizeof(streaming), 0.16f, 1.92f, 1.92f, 1 };
    nemo_speech_asr_recognizer_config config   = { 0 };
    config.size      = sizeof(config);
    config.backend   = &backend;
    config.model     = &model;
    config.streaming = &streaming;

    static stream_state          st;
    nemo_speech_asr_recognizer * recognizer = NULL;
    if (nemo_speech_asr_create(&config, &recognizer) != NEMO_SPEECH_ASR_OK || warm(recognizer, &st) != 0) {
        reply_error(ERR_NATIVE);
        return 4;
    }
    const char * version = nemo_speech_asr_version();
    reply(REPLY_READY, version, (uint32_t) strnlen(version, 64));

    static uint8_t payload[MAX_PUSH_SAMPLES * 2];
    for (;;) {
        uint8_t header[5];
        if (read_full(g_command_fd, header, sizeof(header)) != 0) {
            break; /* parent closed the pipe */
        }
        uint32_t length = (uint32_t) header[0] | ((uint32_t) header[1] << 8) | ((uint32_t) header[2] << 16) | ((uint32_t) header[3] << 24);
        if (length > sizeof(payload) || read_full(g_command_fd, payload, length) != 0) {
            break; /* malformed or truncated frame: the parent will treat the exit as a failure */
        }
        switch (header[4]) {
            case CMD_START:
                if (st.stream) {
                    reply_error(ERR_STATE);
                } else if (length > 1 || (length == 1 && (payload[0] & ~START_INTERIM) != 0)) {
                    reply_error(ERR_PROTOCOL);
                } else if (open_stream(recognizer, &st, length == 1 && (payload[0] & START_INTERIM)) != 0) {
                    reply_error(ERR_NATIVE);
                } else {
                    reply(REPLY_OK, NULL, 0);
                }
                break;
            case CMD_PUSH:
                handle_push(&st, payload, length);
                break;
            case CMD_FINISH:
                handle_finish(&st);
                break;
            case CMD_CLOSE:
                close_stream(&st);
                reply(REPLY_CLOSED, NULL, 0);
                break;
            case CMD_QUIT:
                close_stream(&st);
                nemo_speech_asr_destroy(recognizer);
                return 0;
            default:
                reply_error(ERR_PROTOCOL);
                break;
        }
    }
    close_stream(&st);
    nemo_speech_asr_destroy(recognizer);
    return 0;
}
