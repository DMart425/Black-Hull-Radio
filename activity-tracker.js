'use strict';

/**
 * BHS Activity Tracker
 *
 * Tracks three activity sources and writes them to Supabase:
 *   - Voice sessions  (voiceStateUpdate)
 *   - Game sessions   (presenceUpdate — Star Citizen only by default, or all games)
 *   - SnareHound sessions (called directly from party-api.js push handler)
 *   - Messages sent   (messageCreate — daily count per member)
 *
 * All writes are fire-and-forget. Errors are logged but never thrown, so a
 * Supabase outage cannot affect bot operation.
 *
 * Env vars required:
 *   SUPABASE_URL              — project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (has full DB access)
 *   ACTIVITY_GUILD_ID         — guild to track (defaults to GUILD_ID)
 *   ACTIVITY_AFK_CHANNEL_ID   — voice channel to ignore (defaults to AFK_VOICE_CHANNEL_ID)
 *   ACTIVITY_TRACK_ALL_GAMES  — set to "true" to track all games, not just Star Citizen
 */

const { createClient } = require('@supabase/supabase-js');

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL              = (process.env.SUPABASE_URL              || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const TRACKED_GUILD_ID          = (process.env.ACTIVITY_GUILD_ID         || process.env.GUILD_ID || '').trim();
const AFK_CHANNEL_ID            = (process.env.ACTIVITY_AFK_CHANNEL_ID   || process.env.AFK_VOICE_CHANNEL_ID || '').trim();
// Track all games by default; set ACTIVITY_TRACK_ALL_GAMES=false to restrict to Star Citizen only
const TRACK_ALL_GAMES           = process.env.ACTIVITY_TRACK_ALL_GAMES !== 'false';
const STAR_CITIZEN_APP_ID       = '355493282498600961'; // Discord application ID for Star Citizen

// Known non-game apps that show up as "Playing" in Discord — excluded from tracking
const EXCLUDED_GAME_NAMES = new Set([
  'medal', 'medal.tv', 'medal tv',
  'obs studio', 'obs', 'streamlabs obs', 'streamlabs',
  'twitch studio',
  'nvidia share', 'geforce experience', 'nvidia overlay',
  'xbox game bar', 'xbox',
  'elgato 4k capture utility', 'elgato video capture',
  'action!', 'bandicam', 'fraps', 'dxtory', 'shadowplay',
  'discord',
]);

function isExcludedGame(name) {
  return EXCLUDED_GAME_NAMES.has(name?.toLowerCase()?.trim() ?? '');
}

// Session idle timeout — if no push within this window, close the SnareHound session
const SNAREHOUND_IDLE_MS = 12 * 60 * 1000; // 12 minutes

// ── Supabase client ───────────────────────────────────────────────────────────

let supabase = null;

function getSupabase() {
  if (!supabase) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.warn('[activity-tracker] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — tracking disabled.');
      return null;
    }
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return supabase;
}

function isEnabled() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

// ── In-memory session stores ──────────────────────────────────────────────────

// voice:    discordUserId → { sessionId, startedAt, channelId }
// game:     discordUserId → { sessionId, startedAt, gameName }
// snare:    discordUserId → { sessionId, startedAt, idleTimer }
const voiceSessions    = new Map();
const gameSessions     = new Map();
const snareSessions    = new Map();

// ── Database helpers ──────────────────────────────────────────────────────────

async function insertSession(discordUserId, sessionType, metadata = {}) {
  const db = getSupabase();
  if (!db) return null;
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('activity_sessions')
    .insert({
      discord_user_id: discordUserId,
      session_type: sessionType,
      guild_id: TRACKED_GUILD_ID || null,
      started_at: now,
      ...metadata,
    })
    .select('id')
    .single();
  if (error) {
    console.error(`[activity-tracker] insertSession error (${sessionType}):`, error.message);
    return null;
  }
  return data?.id ?? null;
}

async function closeSession(sessionId, startedAt) {
  const db = getSupabase();
  if (!db || !sessionId) return;
  const endedAt = new Date();
  const durationSeconds = Math.round((endedAt - new Date(startedAt)) / 1000);
  const { error } = await db
    .from('activity_sessions')
    .update({ ended_at: endedAt.toISOString(), duration_seconds: durationSeconds })
    .eq('id', sessionId);
  if (error) {
    console.error('[activity-tracker] closeSession error:', error.message);
  }
}

async function incrementMessageCount(discordUserId, guildId) {
  const db = getSupabase();
  if (!db) return;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const { error } = await db.rpc('increment_message_count', {
    p_discord_user_id: discordUserId,
    p_date: today,
    p_guild_id: guildId || TRACKED_GUILD_ID || null,
    p_delta: 1,
  });
  if (error) {
    console.error('[activity-tracker] incrementMessageCount error:', error.message);
  }
}

// ── Voice tracking ────────────────────────────────────────────────────────────

async function onVoiceStateUpdate(oldState, newState) {
  if (!isEnabled()) return;

  const userId  = newState.id || oldState.id;
  const oldCh   = oldState.channelId;
  const newCh   = newState.channelId;
  const guildId = (newState.guild || oldState.guild)?.id;

  // Only track our guild
  if (TRACKED_GUILD_ID && guildId !== TRACKED_GUILD_ID) return;
  // Ignore bots
  if ((newState.member || oldState.member)?.user?.bot) return;

  const leftChannel  = oldCh && (!newCh || newCh === AFK_CHANNEL_ID);
  const joinedChannel = newCh && newCh !== AFK_CHANNEL_ID && (!oldCh || oldCh === AFK_CHANNEL_ID);
  const movedChannels = oldCh && newCh && oldCh !== newCh && newCh !== AFK_CHANNEL_ID;

  // Joined a real voice channel
  if (joinedChannel || movedChannels) {
    // Close existing session if moving between channels
    if (voiceSessions.has(userId)) {
      const existing = voiceSessions.get(userId);
      voiceSessions.delete(userId);
      await closeSession(existing.sessionId, existing.startedAt);
    }
    if (newCh !== AFK_CHANNEL_ID) {
      const startedAt = new Date().toISOString();
      const sessionId = await insertSession(userId, 'voice');
      if (sessionId) {
        voiceSessions.set(userId, { sessionId, startedAt });
      }
    }
  }

  // Left or moved to AFK
  if (leftChannel && voiceSessions.has(userId)) {
    const session = voiceSessions.get(userId);
    voiceSessions.delete(userId);
    await closeSession(session.sessionId, session.startedAt);
  }
}

// ── Game (presence) tracking ──────────────────────────────────────────────────

function getTrackedGame(presence) {
  if (!presence?.activities) return null;
  for (const activity of presence.activities) {
    // Activity type 0 = Playing
    if (activity.type !== 0) continue;
    // Never track known non-game apps
    if (isExcludedGame(activity.name)) continue;
    if (TRACK_ALL_GAMES) return activity.name;
    // Restricted mode: only Star Citizen
    if (
      activity.applicationId === STAR_CITIZEN_APP_ID ||
      activity.name?.toLowerCase().includes('star citizen')
    ) {
      return activity.name;
    }
  }
  return null;
}

async function onPresenceUpdate(oldPresence, newPresence) {
  if (!isEnabled()) return;

  const userId  = newPresence?.userId || oldPresence?.userId;
  if (!userId) return;

  const guildId = newPresence?.guild?.id || oldPresence?.guild?.id;
  if (TRACKED_GUILD_ID && guildId !== TRACKED_GUILD_ID) return;

  // Ignore bots
  const member = newPresence?.member || oldPresence?.member;
  if (member?.user?.bot) return;

  const wasPlaying = getTrackedGame(oldPresence);
  const isPlaying  = getTrackedGame(newPresence);

  // Started playing a tracked game
  if (!wasPlaying && isPlaying) {
    const startedAt = new Date().toISOString();
    const sessionId = await insertSession(userId, 'game', { metadata: isPlaying });
    if (sessionId) {
      gameSessions.set(userId, { sessionId, startedAt, gameName: isPlaying });
    }
    return;
  }

  // Stopped playing
  if (wasPlaying && !isPlaying && gameSessions.has(userId)) {
    const session = gameSessions.get(userId);
    gameSessions.delete(userId);
    await closeSession(session.sessionId, session.startedAt);
    return;
  }

  // Switched to a different tracked game
  if (wasPlaying && isPlaying && wasPlaying !== isPlaying) {
    if (gameSessions.has(userId)) {
      const session = gameSessions.get(userId);
      gameSessions.delete(userId);
      await closeSession(session.sessionId, session.startedAt);
    }
    const startedAt = new Date().toISOString();
    const sessionId = await insertSession(userId, 'game', { metadata: isPlaying });
    if (sessionId) {
      gameSessions.set(userId, { sessionId, startedAt, gameName: isPlaying });
    }
  }
}

// ── SnareHound session tracking ───────────────────────────────────────────────
// Called from party-api.js whenever a member pushes state.

async function onSnareHoundPush(discordUserId) {
  if (!isEnabled()) return;

  if (snareSessions.has(discordUserId)) {
    // Reset the idle timer
    const session = snareSessions.get(discordUserId);
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => closeSnareSession(discordUserId), SNAREHOUND_IDLE_MS);
    return;
  }

  // New session
  const startedAt = new Date().toISOString();
  const sessionId = await insertSession(discordUserId, 'snarehound');
  if (!sessionId) return;

  const idleTimer = setTimeout(() => closeSnareSession(discordUserId), SNAREHOUND_IDLE_MS);
  snareSessions.set(discordUserId, { sessionId, startedAt, idleTimer });
}

async function closeSnareSession(discordUserId) {
  const session = snareSessions.get(discordUserId);
  if (!session) return;
  clearTimeout(session.idleTimer);
  snareSessions.delete(discordUserId);
  await closeSession(session.sessionId, session.startedAt);
}

// ── Message tracking ──────────────────────────────────────────────────────────

async function onMessageCreate(message) {
  if (!isEnabled()) return;
  if (message.author?.bot) return;
  if (TRACKED_GUILD_ID && message.guildId !== TRACKED_GUILD_ID) return;
  await incrementMessageCount(message.author.id, message.guildId);
}

// ── Cleanup on shutdown ───────────────────────────────────────────────────────
// Call this on SIGTERM/SIGINT to close open sessions cleanly.

async function closeAllSessions() {
  const work = [];

  for (const [userId, session] of voiceSessions) {
    voiceSessions.delete(userId);
    work.push(closeSession(session.sessionId, session.startedAt));
  }
  for (const [userId, session] of gameSessions) {
    gameSessions.delete(userId);
    work.push(closeSession(session.sessionId, session.startedAt));
  }
  for (const [userId, session] of snareSessions) {
    clearTimeout(session.idleTimer);
    snareSessions.delete(userId);
    work.push(closeSession(session.sessionId, session.startedAt));
  }

  await Promise.allSettled(work);
  console.log('[activity-tracker] All open sessions closed.');
}

// ── Startup resume ────────────────────────────────────────────────────────────

/**
 * On bot startup, open voice sessions for any members already sitting in voice.
 * Call this once from the ClientReady handler after the guild is available.
 *
 * @param {import('discord.js').Guild} guild
 */
async function resumeVoiceSessions(guild) {
  if (!isEnabled()) return;
  if (!guild) return;

  let resumed = 0;
  for (const [, channel] of guild.channels.cache) {
    // Only voice channels (type 2 = GuildVoice, type 13 = GuildStageVoice)
    if (channel.type !== 2 && channel.type !== 13) continue;
    // Skip AFK channel
    if (AFK_CHANNEL_ID && channel.id === AFK_CHANNEL_ID) continue;

    for (const [, member] of channel.members) {
      if (member.user.bot) continue;
      if (voiceSessions.has(member.id)) continue; // already tracked

      const startedAt = new Date().toISOString();
      const sessionId = await insertSession(member.id, 'voice');
      if (sessionId) {
        voiceSessions.set(member.id, { sessionId, startedAt });
        resumed++;
      }
    }
  }

  if (resumed > 0) {
    console.log(`[activity-tracker] Resumed voice sessions for ${resumed} member(s) already in voice.`);
  }
}

/**
 * On bot startup, open game sessions for any members already playing a tracked game.
 * Call this once from the ClientReady handler after the guild is available.
 *
 * @param {import('discord.js').Guild} guild
 */
async function resumeGameSessions(guild) {
  if (!isEnabled()) return;
  if (!guild) return;

  let resumed = 0;
  for (const [, member] of guild.members.cache) {
    if (member.user.bot) continue;
    if (gameSessions.has(member.id)) continue; // already tracked

    const gameName = getTrackedGame(member.presence);
    if (!gameName) continue;

    const startedAt = new Date().toISOString();
    const sessionId = await insertSession(member.id, 'game', { metadata: gameName });
    if (sessionId) {
      gameSessions.set(member.id, { sessionId, startedAt, gameName });
      resumed++;
    }
  }

  if (resumed > 0) {
    console.log(`[activity-tracker] Resumed game sessions for ${resumed} member(s) already playing.`);
  }
}

// ── Member join / leave tracking ─────────────────────────────────────────────

/**
 * Record a member joining the guild.
 * @param {import('discord.js').GuildMember} member
 */
async function onGuildMemberAdd(member) {
  if (!isEnabled()) return;
  if (member.user.bot) return;
  if (TRACKED_GUILD_ID && member.guild.id !== TRACKED_GUILD_ID) return;

  const db = getSupabase();
  if (!db) return;

  const { error } = await db.from('member_events').insert({
    discord_user_id: member.id,
    guild_id: member.guild.id,
    event_type: 'join',
    occurred_at: new Date().toISOString(),
  });

  if (error) {
    console.error('[activity-tracker] onGuildMemberAdd insert error:', error.message);
  } else {
    console.log(`[activity-tracker] Member joined: ${member.user.tag} (${member.id})`);
  }
}

/**
 * Record a member leaving the guild.
 * @param {import('discord.js').GuildMember | import('discord.js').PartialGuildMember} member
 */
async function onGuildMemberRemove(member) {
  if (!isEnabled()) return;
  if (member.user?.bot) return;
  if (TRACKED_GUILD_ID && member.guild.id !== TRACKED_GUILD_ID) return;

  const db = getSupabase();
  if (!db) return;

  const { error } = await db.from('member_events').insert({
    discord_user_id: member.id,
    guild_id: member.guild.id,
    event_type: 'leave',
    occurred_at: new Date().toISOString(),
  });

  if (error) {
    console.error('[activity-tracker] onGuildMemberRemove insert error:', error.message);
  } else {
    console.log(`[activity-tracker] Member left: ${member.id}`);
  }
}

module.exports = {
  onVoiceStateUpdate,
  onPresenceUpdate,
  onSnareHoundPush,
  onMessageCreate,
  closeAllSessions,
  resumeVoiceSessions,
  resumeGameSessions,
  onGuildMemberAdd,
  onGuildMemberRemove,
  isEnabled,
};
