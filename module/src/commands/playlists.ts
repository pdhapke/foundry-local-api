// Phase 17 — Playlists & Audio command handlers. Registered against the
// same command dispatcher registry Phase 2 set up
// (module/src/command-registry.ts) and imported for side effects from
// module/src/index.ts.
//
// Playlist CRUD itself is NOT re-implemented here: it's already covered
// generically by Phase 8's documentList/Get/Create/Update/Delete commands
// with `documentType: "Playlist"` (see server/src/endpoints/playlists.ts,
// which calls the same `makeDocumentEndpoints()` factory JournalEntry/Actor/
// Item/Scene/Macro/Combat use). This file only adds the playlist-specific
// extras PLAN.md's Phase 17 calls for: play/stop/pause of a single embedded
// PlaylistSound.
//
// Pausing has no dedicated Foundry method (unlike play/stop, which are
// `Playlist#playSound()`/`stopSound()`) — Foundry's own playlist sidebar
// implements it as a plain document update recording the sound's current
// playback position (`pausedTime`) and flipping `playing` off, which
// `PlaylistSound#update()`'s next `play` (via `playSound()`) resumes from.
import {
  PLAYLIST_COMMANDS,
  type DocumentData,
  type PlaylistIdInput,
  type PlaylistSoundIdInput,
} from "@foundry-local-api/shared";

import { registerCommand } from "../command-registry.js";

function requirePlaylist(id: string): FoundryPlaylist {
  const collection = game.collections.get("Playlist") as Map<string, FoundryPlaylist> | undefined;
  const playlist = collection?.get(id);
  if (!playlist) {
    throw new Error(`Playlist "${id}" not found`);
  }
  return playlist;
}

function requireSound(playlist: FoundryPlaylist, soundId: string): FoundryPlaylistSound {
  const sound = playlist.sounds.get(soundId);
  if (!sound) {
    throw new Error(`PlaylistSound "${soundId}" not found on playlist "${playlist.id}"`);
  }
  return sound;
}

registerCommand(
  PLAYLIST_COMMANDS.PLAY_SOUND,
  async ({ id, soundId }: PlaylistSoundIdInput): Promise<DocumentData> => {
    const playlist = requirePlaylist(id);
    const sound = requireSound(playlist, soundId);
    await playlist.playSound(sound);
    return requireSound(playlist, soundId).toObject();
  },
);

registerCommand(
  PLAYLIST_COMMANDS.STOP_SOUND,
  async ({ id, soundId }: PlaylistSoundIdInput): Promise<DocumentData> => {
    const playlist = requirePlaylist(id);
    const sound = requireSound(playlist, soundId);
    await playlist.stopSound(sound);
    return requireSound(playlist, soundId).toObject();
  },
);

registerCommand(
  PLAYLIST_COMMANDS.PAUSE_SOUND,
  async ({ id, soundId }: PlaylistSoundIdInput): Promise<DocumentData> => {
    const sound = requireSound(requirePlaylist(id), soundId);
    const updated = await sound.update({
      playing: false,
      pausedTime: sound.sound?.currentTime ?? 0,
    });
    return updated.toObject();
  },
);

registerCommand(
  PLAYLIST_COMMANDS.PLAY_ALL,
  async ({ id }: PlaylistIdInput): Promise<DocumentData> => {
    const playlist = requirePlaylist(id);
    await playlist.playAll();
    return requirePlaylist(id).toObject();
  },
);

registerCommand(
  PLAYLIST_COMMANDS.STOP_ALL,
  async ({ id }: PlaylistIdInput): Promise<DocumentData> => {
    const playlist = requirePlaylist(id);
    await playlist.stopAll();
    return requirePlaylist(id).toObject();
  },
);
