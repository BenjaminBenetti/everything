import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "../../session/component/session-provider.js";
import type { MediaEnvironment } from "../interface/media-environment.js";
import type { VoiceClient } from "../interface/voice-client.js";

/** Voice input capabilities supplied at the application boundary. */
interface VoiceContextValue {
  readonly client: VoiceClient;
  readonly media: MediaEnvironment;
}

const VoiceContext = createContext<VoiceContextValue | null>(null);

/** Supply transcription and microphone access independently of transport and browser APIs. */
export function VoiceProvider({
  client,
  media,
  children,
}: VoiceContextValue & { children: ReactNode }) {
  return (
    <VoiceContext.Provider value={{ client, media }}>
      {children}
    </VoiceContext.Provider>
  );
}

/** Resolve the voice capabilities assembled at the application boundary. */
export function useVoice(): VoiceContextValue {
  const voice = useContext(VoiceContext);
  if (!voice) throw new Error("VoiceProvider is required");
  return voice;
}

/** Share whether this installation transcribes recordings; it rarely changes. */
export function useVoiceCapabilities() {
  const { client } = useVoice();
  const { profile } = useSession();
  return useQuery({
    queryKey: ["voice", profile?.subject, "capabilities"],
    queryFn: ({ signal }) => client.capabilities(signal),
    enabled: !!profile,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
