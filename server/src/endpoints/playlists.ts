// Phase 17 — Playlists & Audio.
//
// Base CRUD reuses the Phase 8 `makeDocumentEndpoints()` factory with
// `documentType: "Playlist"`, same as JournalEntry/Actor/Item/Scene/Macro/
// Combat. The extras PLAN.md's Phase 17 calls for (play/stop/pause sound)
// are hand-rolled here, operating on a single embedded PlaylistSound — see
// module/src/commands/playlists.ts for the matching module-side handlers.
//
// All three return the affected PlaylistSound's own `toObject()` (not the
// parent Playlist's), so a caller can see the sound's new `playing`/
// `pausedTime` state without a follow-up `GET` — consistent with how every
// embedded-create descriptor since Phase 10 returns the created child, not
// the parent.
import { z } from "zod";

import {
  PLAYLIST_COMMANDS,
  type DocumentData,
  type PlaylistSoundIdInput,
} from "@foundry-local-api/shared";

import { makeDocumentEndpoints } from "./documents.js";
import type { AnyEndpointDescriptor, EndpointDescriptor } from "./types.js";

const soundIdSchema = z.object({ id: z.string().min(1), soundId: z.string().min(1) });

const playSoundDescriptor: EndpointDescriptor<PlaylistSoundIdInput, DocumentData> = {
  name: "foundry_play_playlist_sound",
  description: "Starts playback of a single sound within a playlist.",
  method: "post",
  path: "/playlists/:id/sounds/:soundId/play",
  inputSchema: soundIdSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<PlaylistSoundIdInput, DocumentData>(PLAYLIST_COMMANDS.PLAY_SOUND, input),
};

const stopSoundDescriptor: EndpointDescriptor<PlaylistSoundIdInput, DocumentData> = {
  name: "foundry_stop_playlist_sound",
  description: "Stops playback of a single sound within a playlist and resets its position.",
  method: "post",
  path: "/playlists/:id/sounds/:soundId/stop",
  inputSchema: soundIdSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<PlaylistSoundIdInput, DocumentData>(PLAYLIST_COMMANDS.STOP_SOUND, input),
};

const pauseSoundDescriptor: EndpointDescriptor<PlaylistSoundIdInput, DocumentData> = {
  name: "foundry_pause_playlist_sound",
  description:
    "Pauses playback of a single sound within a playlist, recording its position so a later " +
    "play resumes from where it left off.",
  method: "post",
  path: "/playlists/:id/sounds/:soundId/pause",
  inputSchema: soundIdSchema,
  handler: (input, { foundryClient }) =>
    foundryClient.call<PlaylistSoundIdInput, DocumentData>(PLAYLIST_COMMANDS.PAUSE_SOUND, input),
};

export const playlistEndpointDescriptors: AnyEndpointDescriptor[] = [
  ...makeDocumentEndpoints({
    documentType: "Playlist",
    routeBase: "playlists",
    toolSingular: "playlist",
    toolPlural: "playlists",
  }),
  playSoundDescriptor,
  stopSoundDescriptor,
  pauseSoundDescriptor,
];
