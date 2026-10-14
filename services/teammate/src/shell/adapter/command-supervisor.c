#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

// ===========================================
// Descendant cleanup
// ===========================================

/** Kill direct children, including detached descendants adopted by this subreaper. */
static int kill_children(void) {
    char path[80];
    snprintf(path, sizeof(path), "/proc/self/task/%ld/children", (long)getpid());
    FILE *children = fopen(path, "r");
    if (!children) return -1;
    long child;
    while (fscanf(children, "%ld", &child) == 1) {
        // A child PID cannot be reused until this single-threaded parent reaps it.
        if (kill((pid_t)child, SIGKILL) < 0 && errno != ESRCH) {
            fclose(children);
            return -1;
        }
    }
    int failed = ferror(children);
    fclose(children);
    return failed ? -1 : 0;
}

/** Reap every descendant, repeating as killed parents hand their children to this subreaper. */
static int cleanup(pid_t shell, int *shell_status) {
    for (;;) {
        if (kill_children() < 0) return -1;
        int status;
        pid_t child = waitpid(-1, &status, 0);
        if (child == shell) *shell_status = status;
        if (child < 0) {
            if (errno == ECHILD) return 0;
            if (errno != EINTR) return -1;
        }
    }
}

// ===========================================
// Command lifecycle
// ===========================================

/** Wait for Bash completion or interruption while reaping any orphaned background children. */
static int await_shell(pid_t shell, const sigset_t *signals, int *shell_status) {
    for (;;) {
        int status;
        pid_t child;
        while ((child = waitpid(-1, &status, WNOHANG)) > 0) {
            if (child == shell) {
                *shell_status = status;
                return 0;
            }
        }
        if (child < 0 && errno != EINTR) return -1;
        int received = sigwaitinfo(signals, NULL);
        if (received == SIGTERM || received == SIGINT || received == SIGHUP) return 0;
        if (received < 0 && errno != EINTR) return -1;
    }
}

/** Preserve Bash's exact exit code or terminating signal after all of its descendants are gone. */
static int exit_status(int status, const sigset_t *original_mask) {
    if (WIFSIGNALED(status)) {
        int received = WTERMSIG(status);
        signal(received, SIG_DFL);
        sigprocmask(SIG_SETMASK, original_mask, NULL);
        kill(getpid(), received);
        return 128 + received;
    }
    return WIFEXITED(status) ? WEXITSTATUS(status) : 125;
}

/** Supervise one Bash invocation without signalling any other command in the container. */
int main(int argc, char **argv) {
    if (argc != 2) return 125;
    sigset_t signals, original_mask;
    sigemptyset(&signals);
    sigaddset(&signals, SIGCHLD);
    sigaddset(&signals, SIGTERM);
    sigaddset(&signals, SIGINT);
    sigaddset(&signals, SIGHUP);
    pid_t parent = getppid();
    if (sigprocmask(SIG_BLOCK, &signals, &original_mask) < 0 ||
        prctl(PR_SET_CHILD_SUBREAPER, 1) < 0 ||
        prctl(PR_SET_PDEATHSIG, SIGHUP) < 0) {
        perror("Unable to supervise command");
        return 125;
    }
    // If the API died before installing the parent-death signal, there is no work to start.
    if (getppid() != parent) return 125;
    pid_t shell = fork();
    if (shell < 0) {
        perror("Unable to start command");
        return 125;
    }
    if (shell == 0) {
        sigprocmask(SIG_SETMASK, &original_mask, NULL);
        execl("/bin/bash", "bash", "--noprofile", "--norc", "-c", argv[1], (char *)NULL);
        perror("Unable to start Bash");
        _exit(127);
    }
    int status = 0;
    int failed = await_shell(shell, &signals, &status);
    if (cleanup(shell, &status) < 0) failed = -1;
    if (failed) {
        perror("Unable to clean up command");
        return 125;
    }
    return exit_status(status, &original_mask);
}
