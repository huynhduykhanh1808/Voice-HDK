const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  SlashCommandBuilder,
  OverwriteType
} = require('discord.js');

const { Pool } = require('pg');
const http = require('http');

const BOT_NAME = 'Voice HDK';
const BOT_VERSION = '8.1.0';

const TOKEN = process.env.DISCORD_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT || 3000);

const TIME_ZONE = 'Asia/Ho_Chi_Minh';

const CREATE_VOICE_NAME = '➕ Tạo phòng';
const ROOM_PREFIX = '🔊・';

const CHAT_LOG_CHANNEL_NAME = '💬・nhật-ký-chat';
const ACTION_LOG_CHANNEL_NAME = '⚙️・nhật-ký-chức-năng';

const NOTICE_DELETE_MS = 5000;
const ACTION_COOLDOWN_MS = 1500;

const TRANSFER_TIMEOUT_MS = 60 * 1000;
const OWNER_ABSENCE_GRACE_MS = 10 * 60 * 1000;
const AUTO_TRANSFER_RETRY_MS = 60 * 1000;

const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const SELECTED_MEMBER_TIMEOUT_MS = 10 * 60 * 1000;

const EMPTY_ROOM_DELETE_DELAY_MS = 2500;
const REGION_CACHE_MS = 30 * 60 * 1000;

if (!TOKEN) {
  throw new Error('Thiếu biến môi trường DISCORD_TOKEN.');
}

if (!DATABASE_URL) {
  throw new Error('Thiếu biến môi trường DATABASE_URL.');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.User,
    Partials.GuildMember
  ]
});

const pool = new Pool({
  connectionString: DATABASE_URL
});

pool.on('error', error => {
  logError('POSTGRES_POOL', error);
});

const panelLocks = new Map();
const createLocks = new Map();
const roomLifecycleLocks = new Map();

const cooldowns = new Map();
const selectedMembers = new Map();
const pendingTransfers = new Map();
const setupSessions = new Map();

const emptyRoomTimers = new Map();
const ownerAbsenceTimers = new Map();

const setupCleanupGuilds = new Set();

let regionCache = {
  fetchedAt: 0,
  regions: []
};

let shuttingDown = false;

const UI_COLORS = {
  blue: 0x4f6faf,
  green: 0x4f8a68,
  orange: 0xb8793e,
  purple: 0x75639b
};

const REQUIRED_BOT_PERMISSIONS = {
  ViewChannel: PermissionsBitField.Flags.ViewChannel,
  SendMessages: PermissionsBitField.Flags.SendMessages,
  EmbedLinks: PermissionsBitField.Flags.EmbedLinks,
  ReadMessageHistory: PermissionsBitField.Flags.ReadMessageHistory,
  ManageChannels: PermissionsBitField.Flags.ManageChannels,
  ManageRoles: PermissionsBitField.Flags.ManageRoles,
  MoveMembers: PermissionsBitField.Flags.MoveMembers,
  Connect: PermissionsBitField.Flags.Connect
};

function logError(scope, error) {
  console.error(
    `[${BOT_NAME}] [${scope}]`,
    error?.stack ||
      error?.message ||
      String(error)
  );
}

client.on(Events.Error, error => {
  logError('DISCORD_CLIENT', error);
});

client.on(Events.Warn, warning => {
  console.warn(
    `[${BOT_NAME}] [DISCORD_WARN]`,
    warning
  );
});

/*
 * LƯU Ý:
 * Health server + process error handlers được đặt ở cuối file.
 * Không khai báo tại đây để tránh:
 *
 * SyntaxError:
 * Identifier 'healthServer' has already been declared
 */

function isSnowflake(value) {
  return /^\d{16,22}$/.test(
    String(value || '')
  );
}

function cleanDisplayName(value) {
  return String(value || '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function cleanRoomName(value) {
  let name = cleanDisplayName(
    value
  );

  if (
    name.startsWith(
      ROOM_PREFIX
    )
  ) {
    name = name.slice(
      ROOM_PREFIX.length
    );
  }

  return name
    .replace(/[<>@#`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function safeMemberName(member) {
  return cleanDisplayName(
    member?.displayName ||
      member?.user?.globalName ||
      member?.user?.username ||
      'Thành viên'
  );
}

function vietnamTime(
  date = new Date()
) {
  return new Intl.DateTimeFormat(
    'vi-VN',
    {
      timeZone: TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour12: false
    }
  )
    .format(date)
    .replace(',', '');
}

function relativeTimestamp(
  value
) {
  const time =
    value instanceof Date
      ? value.getTime()
      : new Date(value).getTime();

  return `<t:${Math.floor(
    time / 1000
  )}:R>`;
}

function actionDeleteTimestamp(
  milliseconds =
    NOTICE_DELETE_MS
) {
  return relativeTimestamp(
    Date.now() +
      milliseconds
  );
}

function sleep(
  milliseconds
) {
  return new Promise(resolve => {
    setTimeout(
      resolve,
      milliseconds
    );
  });
}

function selectedMemberKey(
  guildId,
  channelId,
  ownerId
) {
  return [
    String(guildId),
    String(channelId),
    String(ownerId)
  ].join(':');
}

function transferKey(
  channelId
) {
  return String(
    channelId
  );
}

function roomCreateLockKey(
  guildId,
  memberId
) {
  return `${guildId}:${memberId}`;
}

function setupSessionKey(
  guildId,
  userId
) {
  return `${guildId}:${userId}`;
}

function clearEmptyRoomTimer(
  channelId
) {
  const key =
    String(channelId);

  const timer =
    emptyRoomTimers.get(
      key
    );

  if (timer) {
    clearTimeout(
      timer
    );
  }

  emptyRoomTimers.delete(
    key
  );
}

function clearOwnerAbsenceTimer(
  channelId
) {
  const key =
    String(channelId);

  const timer =
    ownerAbsenceTimers.get(
      key
    );

  if (timer) {
    clearTimeout(
      timer
    );
  }

  ownerAbsenceTimers.delete(
    key
  );
}

function clearPendingTransfer(
  channelId
) {
  const key =
    transferKey(
      channelId
    );

  const transfer =
    pendingTransfers.get(
      key
    );

  if (
    transfer?.timer
  ) {
    clearTimeout(
      transfer.timer
    );
  }

  pendingTransfers.delete(
    key
  );
}

function clearSelectedMembersForChannel(
  channelId
) {
  const id =
    String(channelId);

  for (
    const [key, state]
    of selectedMembers
  ) {
    if (
      String(
        state.channelId
      ) === id
    ) {
      selectedMembers.delete(
        key
      );
    }
  }
}

function clearRoomRuntimeState(
  channelId
) {
  const id =
    String(channelId);

  clearEmptyRoomTimer(
    id
  );

  clearOwnerAbsenceTimer(
    id
  );

  clearPendingTransfer(
    id
  );

  clearSelectedMembersForChannel(
    id
  );

  panelLocks.delete(
    id
  );

  roomLifecycleLocks.delete(
    id
  );
}

function clearGuildRuntimeState(
  guildId
) {
  const id =
    String(guildId);

  for (
    const [key, state]
    of selectedMembers
  ) {
    if (
      String(
        state.guildId
      ) === id
    ) {
      selectedMembers.delete(
        key
      );
    }
  }

  for (
    const [key, transfer]
    of pendingTransfers
  ) {
    if (
      String(
        transfer.guildId
      ) === id
    ) {
      if (
        transfer.timer
      ) {
        clearTimeout(
          transfer.timer
        );
      }

      pendingTransfers.delete(
        key
      );
    }
  }

  for (
    const [key, session]
    of setupSessions
  ) {
    if (
      String(
        session.guildId
      ) === id
    ) {
      if (
        session?.timer
      ) {
        clearTimeout(
          session.timer
        );
      }

      setupSessions.delete(
        key
      );
    }
  }
}

async function initDatabase() {
  const db =
    await pool.connect();

  try {
    await db.query(
      'BEGIN'
    );

    await db.query(`
      CREATE TABLE IF NOT EXISTS generators (
        guild_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        button_category_id TEXT,
        blog_category_id TEXT,
        create_voice_id TEXT,
        chat_log_channel_id TEXT,
        action_log_channel_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        category_id TEXT,
        control_message_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        rooms_one_owner_per_guild
      ON rooms (
        guild_id,
        owner_id
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS
        rooms_guild_idx
      ON rooms (
        guild_id
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS room_presence (
        channel_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (
          channel_id,
          member_id
        )
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS
        room_presence_oldest_idx
      ON room_presence (
        channel_id,
        joined_at ASC
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS owner_absence (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        deadline_at TIMESTAMPTZ NOT NULL,
        notice_message_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS room_bans (
        channel_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        banned_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (
          channel_id,
          member_id
        )
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS
        room_bans_guild_idx
      ON room_bans (
        guild_id
      )
    `);

    await db.query(
      'COMMIT'
    );
  } catch (error) {
    await db.query(
      'ROLLBACK'
    ).catch(
      () => {}
    );

    throw error;
  } finally {
    db.release();
  }
}

async function getGenerator(
  guildId
) {
  const result =
    await pool.query(
      `
        SELECT *
        FROM generators
        WHERE guild_id = $1
        LIMIT 1
      `,
      [
        String(guildId)
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}

async function saveGenerator({
  guildId,
  displayName,
  buttonCategoryId,
  blogCategoryId,
  createVoiceId,
  chatLogChannelId,
  actionLogChannelId
}) {
  const result =
    await pool.query(
      `
        INSERT INTO generators (
          guild_id,
          display_name,
          button_category_id,
          blog_category_id,
          create_voice_id,
          chat_log_channel_id,
          action_log_channel_id,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          NOW(),
          NOW()
        )
        ON CONFLICT (
          guild_id
        )
        DO UPDATE SET
          display_name =
            EXCLUDED.display_name,
          button_category_id =
            EXCLUDED.button_category_id,
          blog_category_id =
            EXCLUDED.blog_category_id,
          create_voice_id =
            EXCLUDED.create_voice_id,
          chat_log_channel_id =
            EXCLUDED.chat_log_channel_id,
          action_log_channel_id =
            EXCLUDED.action_log_channel_id,
          updated_at =
            NOW()
        RETURNING *
      `,
      [
        String(guildId),
        cleanDisplayName(
          displayName
        ) || 'Voice HDK',
        buttonCategoryId
          ? String(
              buttonCategoryId
            )
          : null,
        blogCategoryId
          ? String(
              blogCategoryId
            )
          : null,
        createVoiceId
          ? String(
              createVoiceId
            )
          : null,
        chatLogChannelId
          ? String(
              chatLogChannelId
            )
          : null,
        actionLogChannelId
          ? String(
              actionLogChannelId
            )
          : null
      ]
    );

  return result.rows[0];
}

async function clearGeneratorChannelId(
  guildId,
  column
) {
  const allowed =
    new Set([
      'create_voice_id',
      'chat_log_channel_id',
      'action_log_channel_id'
    ]);

  if (
    !allowed.has(
      column
    )
  ) {
    throw new Error(
      'Generator column không hợp lệ.'
    );
  }

  await pool.query(
    `
      UPDATE generators
      SET
        ${column} = NULL,
        updated_at = NOW()
      WHERE guild_id = $1
    `,
    [
      String(guildId)
    ]
  );
}

async function deleteGenerator(
  guildId,
  db = pool
) {
  await db.query(
    `
      DELETE FROM generators
      WHERE guild_id = $1
    `,
    [
      String(guildId)
    ]
  );
}

async function getRoom(
  channelId
) {
  const result =
    await pool.query(
      `
        SELECT *
        FROM rooms
        WHERE channel_id = $1
        LIMIT 1
      `,
      [
        String(channelId)
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}

async function getOwnedRoom(
  guildId,
  ownerId
) {
  const result =
    await pool.query(
      `
        SELECT *
        FROM rooms
        WHERE
          guild_id = $1
          AND owner_id = $2
        LIMIT 1
      `,
      [
        String(guildId),
        String(ownerId)
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}

async function getGuildRooms(
  guildId
) {
  const result =
    await pool.query(
      `
        SELECT *
        FROM rooms
        WHERE guild_id = $1
        ORDER BY created_at ASC
      `,
      [
        String(guildId)
      ]
    );

  return result.rows;
}

async function saveRoom({
  guildId,
  channelId,
  ownerId,
  categoryId,
  controlMessageId = null
}) {
  const result =
    await pool.query(
      `
        INSERT INTO rooms (
          guild_id,
          channel_id,
          owner_id,
          category_id,
          control_message_id,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          NOW(),
          NOW()
        )
        ON CONFLICT (
          channel_id
        )
        DO UPDATE SET
          guild_id =
            EXCLUDED.guild_id,
          owner_id =
            EXCLUDED.owner_id,
          category_id =
            EXCLUDED.category_id,
          control_message_id =
            EXCLUDED.control_message_id,
          updated_at =
            NOW()
        RETURNING *
      `,
      [
        String(guildId),
        String(channelId),
        String(ownerId),
        categoryId
          ? String(
              categoryId
            )
          : null,
        controlMessageId
          ? String(
              controlMessageId
            )
          : null
      ]
    );

  return result.rows[0];
}

async function setControlMessage(
  channelId,
  messageId
) {
  const result =
    await pool.query(
      `
        UPDATE rooms
        SET
          control_message_id = $2,
          updated_at = NOW()
        WHERE channel_id = $1
        RETURNING *
      `,
      [
        String(channelId),
        messageId
          ? String(
              messageId
            )
          : null
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}

async function updateRoomOwner(
  channelId,
  ownerId,
  db = pool
) {
  const result =
    await db.query(
      `
        UPDATE rooms
        SET
          owner_id = $2,
          updated_at = NOW()
        WHERE channel_id = $1
        RETURNING *
      `,
      [
        String(channelId),
        String(ownerId)
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}
async function deleteRoomRecord(
  channelId,
  db = pool
) {
  const id =
    String(channelId);

  await db.query(
    `
      DELETE FROM room_bans
      WHERE channel_id = $1
    `,
    [id]
  );

  await db.query(
    `
      DELETE FROM room_presence
      WHERE channel_id = $1
    `,
    [id]
  );

  await db.query(
    `
      DELETE FROM owner_absence
      WHERE channel_id = $1
    `,
    [id]
  );

  await db.query(
    `
      DELETE FROM rooms
      WHERE channel_id = $1
    `,
    [id]
  );
}

async function deleteGuildVoiceData(
  guildId,
  db = pool
) {
  const id =
    String(guildId);

  await db.query(
    `
      DELETE FROM room_bans
      WHERE guild_id = $1
    `,
    [id]
  );

  await db.query(
    `
      DELETE FROM room_presence
      WHERE guild_id = $1
    `,
    [id]
  );

  await db.query(
    `
      DELETE FROM owner_absence
      WHERE guild_id = $1
    `,
    [id]
  );

  await db.query(
    `
      DELETE FROM rooms
      WHERE guild_id = $1
    `,
    [id]
  );
}

async function recordMemberPresence(
  guildId,
  channelId,
  memberId,
  joinedAt = new Date()
) {
  await pool.query(
    `
      INSERT INTO room_presence (
        guild_id,
        channel_id,
        member_id,
        joined_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4
      )
      ON CONFLICT (
        channel_id,
        member_id
      )
      DO NOTHING
    `,
    [
      String(guildId),
      String(channelId),
      String(memberId),
      joinedAt
    ]
  );
}

async function removeMemberPresence(
  channelId,
  memberId
) {
  await pool.query(
    `
      DELETE FROM room_presence
      WHERE
        channel_id = $1
        AND member_id = $2
    `,
    [
      String(channelId),
      String(memberId)
    ]
  );
}

async function getRoomPresence(
  channelId
) {
  const result =
    await pool.query(
      `
        SELECT *
        FROM room_presence
        WHERE channel_id = $1
        ORDER BY
          joined_at ASC,
          member_id ASC
      `,
      [
        String(channelId)
      ]
    );

  return result.rows;
}

async function saveOwnerAbsence({
  guildId,
  channelId,
  ownerId,
  deadlineAt,
  noticeMessageId = null
}) {
  const result =
    await pool.query(
      `
        INSERT INTO owner_absence (
          guild_id,
          channel_id,
          owner_id,
          deadline_at,
          notice_message_id,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          NOW(),
          NOW()
        )
        ON CONFLICT (
          channel_id
        )
        DO UPDATE SET
          guild_id =
            EXCLUDED.guild_id,
          owner_id =
            EXCLUDED.owner_id,
          deadline_at =
            EXCLUDED.deadline_at,
          notice_message_id =
            EXCLUDED.notice_message_id,
          updated_at =
            NOW()
        RETURNING *
      `,
      [
        String(guildId),
        String(channelId),
        String(ownerId),
        deadlineAt,
        noticeMessageId
          ? String(
              noticeMessageId
            )
          : null
      ]
    );

  return result.rows[0];
}

async function getOwnerAbsence(
  channelId
) {
  const result =
    await pool.query(
      `
        SELECT *
        FROM owner_absence
        WHERE channel_id = $1
        LIMIT 1
      `,
      [
        String(channelId)
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}

async function setOwnerAbsenceNotice(
  channelId,
  messageId
) {
  await pool.query(
    `
      UPDATE owner_absence
      SET
        notice_message_id = $2,
        updated_at = NOW()
      WHERE channel_id = $1
    `,
    [
      String(channelId),
      messageId
        ? String(
            messageId
          )
        : null
    ]
  );
}

async function deleteOwnerAbsence(
  channelId,
  db = pool
) {
  await db.query(
    `
      DELETE FROM owner_absence
      WHERE channel_id = $1
    `,
    [
      String(channelId)
    ]
  );
}

async function addRoomBan(
  guildId,
  channelId,
  memberId,
  bannedBy
) {
  const result =
    await pool.query(
      `
        INSERT INTO room_bans (
          guild_id,
          channel_id,
          member_id,
          banned_by,
          created_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          NOW()
        )
        ON CONFLICT (
          channel_id,
          member_id
        )
        DO UPDATE SET
          banned_by =
            EXCLUDED.banned_by,
          created_at =
            NOW()
        RETURNING *
      `,
      [
        String(guildId),
        String(channelId),
        String(memberId),
        bannedBy
          ? String(
              bannedBy
            )
          : null
      ]
    );

  return result.rows[0];
}

async function removeRoomBan(
  channelId,
  memberId
) {
  await pool.query(
    `
      DELETE FROM room_bans
      WHERE
        channel_id = $1
        AND member_id = $2
    `,
    [
      String(channelId),
      String(memberId)
    ]
  );
}

async function isRoomBanned(
  channelId,
  memberId
) {
  const result =
    await pool.query(
      `
        SELECT 1
        FROM room_bans
        WHERE
          channel_id = $1
          AND member_id = $2
        LIMIT 1
      `,
      [
        String(channelId),
        String(memberId)
      ]
    );

  return (
    result.rowCount >
    0
  );
}

async function getRoomBans(
  channelId
) {
  const result =
    await pool.query(
      `
        SELECT *
        FROM room_bans
        WHERE channel_id = $1
        ORDER BY created_at ASC
      `,
      [
        String(channelId)
      ]
    );

  return result.rows;
}

async function clearRoomBans(
  channelId,
  db = pool
) {
  await db.query(
    `
      DELETE FROM room_bans
      WHERE channel_id = $1
    `,
    [
      String(channelId)
    ]
  );
}

function isUnknownDiscordResource(
  error
) {
  const code =
    Number(
      error?.code ||
      error?.rawError?.code ||
      0
    );

  return [
    10003,
    10008,
    10013,
    10062
  ].includes(code);
}

function isCategoryChannel(
  channel
) {
  return Boolean(
    channel &&
    channel.type ===
      ChannelType.GuildCategory
  );
}

function isVoiceChannel(
  channel
) {
  return Boolean(
    channel &&
    channel.type ===
      ChannelType.GuildVoice
  );
}

function isTextChannel(
  channel
) {
  return Boolean(
    channel &&
    channel.type ===
      ChannelType.GuildText
  );
}

function isHumanMember(
  member
) {
  return Boolean(
    member &&
    !member.user?.bot
  );
}

function humanMembers(
  channel
) {
  if (
    !channel?.members
  ) {
    return [];
  }

  return [
    ...channel.members.values()
  ].filter(
    member =>
      isHumanMember(
        member
      )
  );
}

async function fetchMemberSafe(
  guild,
  memberId
) {
  if (
    !guild ||
    !isSnowflake(
      memberId
    )
  ) {
    return null;
  }

  try {
    return await guild.members.fetch({
      user:
        String(memberId),
      force:
        true
    });
  } catch (error) {
    if (
      !isUnknownDiscordResource(
        error
      )
    ) {
      logError(
        'FETCH_MEMBER',
        error
      );
    }

    return null;
  }
}

async function fetchChannelSafe(
  guild,
  channelId
) {
  if (
    !guild ||
    !isSnowflake(
      channelId
    )
  ) {
    return null;
  }

  try {
    return await guild.channels.fetch(
      String(channelId)
    );
  } catch (error) {
    if (
      !isUnknownDiscordResource(
        error
      )
    ) {
      logError(
        'FETCH_CHANNEL',
        error
      );
    }

    return null;
  }
}

async function fetchMessageSafe(
  channel,
  messageId
) {
  if (
    !channel?.isTextBased?.() ||
    !isSnowflake(
      messageId
    )
  ) {
    return null;
  }

  try {
    return await channel.messages.fetch(
      String(messageId)
    );
  } catch (error) {
    if (
      !isUnknownDiscordResource(
        error
      )
    ) {
      logError(
        'FETCH_MESSAGE',
        error
      );
    }

    return null;
  }
}

async function safeDeleteMessage(
  message
) {
  if (!message) {
    return false;
  }

  try {
    await message.delete();

    return true;
  } catch (error) {
    if (
      !isUnknownDiscordResource(
        error
      )
    ) {
      logError(
        'DELETE_MESSAGE',
        error
      );
    }

    return false;
  }
}

async function safeDeleteChannel(
  channel,
  reason
) {
  if (!channel) {
    return false;
  }

  try {
    await channel.delete(
      reason
    );

    return true;
  } catch (error) {
    if (
      !isUnknownDiscordResource(
        error
      )
    ) {
      logError(
        'DELETE_CHANNEL',
        error
      );
    }

    return false;
  }
}

async function safeEditChannel(
  channel,
  options,
  reason
) {
  if (!channel) {
    return null;
  }

  try {
    return await channel.edit(
      options,
      reason
    );
  } catch (error) {
    logError(
      'EDIT_CHANNEL',
      error
    );

    return null;
  }
}

async function withMapLock(
  map,
  key,
  callback
) {
  const lockKey =
    String(key);

  const previous =
    map.get(
      lockKey
    ) ||
    Promise.resolve();

  let release;

  const gate =
    new Promise(
      resolve => {
        release =
          resolve;
      }
    );

  const current =
    previous
      .catch(
        () => {}
      )
      .then(
        () => gate
      );

  map.set(
    lockKey,
    current
  );

  await previous.catch(
    () => {}
  );

  try {
    return await callback();
  } finally {
    release();

    if (
      map.get(
        lockKey
      ) === current
    ) {
      map.delete(
        lockKey
      );
    }
  }
}

function withPanelLock(
  channelId,
  callback
) {
  return withMapLock(
    panelLocks,
    channelId,
    callback
  );
}

function withCreateLock(
  guildId,
  memberId,
  callback
) {
  return withMapLock(
    createLocks,
    roomCreateLockKey(
      guildId,
      memberId
    ),
    callback
  );
}

function withRoomLifecycleLock(
  channelId,
  callback
) {
  return withMapLock(
    roomLifecycleLocks,
    channelId,
    callback
  );
}

function cooldownKey(
  interaction,
  action
) {
  return [
    interaction.guildId ||
      'dm',
    interaction.user?.id ||
      'unknown',
    action
  ].join(':');
}

function useCooldown(
  interaction,
  action,
  duration =
    ACTION_COOLDOWN_MS
) {
  const key =
    cooldownKey(
      interaction,
      action
    );

  const now =
    Date.now();

  const expiresAt =
    cooldowns.get(
      key
    ) ||
    0;

  if (
    expiresAt >
    now
  ) {
    return (
      expiresAt -
      now
    );
  }

  cooldowns.set(
    key,
    now +
      duration
  );

  const timer =
    setTimeout(
      () => {
        if (
          (
            cooldowns.get(
              key
            ) ||
            0
          ) <=
          Date.now()
        ) {
          cooldowns.delete(
            key
          );
        }
      },
      duration +
        1000
    );

  timer.unref?.();

  return 0;
}

function noticeIcon(
  type
) {
  switch (type) {
    case 'success':
      return '🟢';

    case 'warning':
      return '🟠';

    case 'error':
      return '🔴';

    default:
      return '🔵';
  }
}

function buildNoticeText(
  content,
  type = 'info'
) {
  return `${noticeIcon(type)} ${String(
    content ||
    ''
  ).trim()}`;
}

function scheduleOriginalReplyDelete(
  interaction,
  milliseconds =
    NOTICE_DELETE_MS
) {
  const timer =
    setTimeout(
      async () => {
        try {
          await interaction.deleteReply();
        } catch (error) {
          if (
            !isUnknownDiscordResource(
              error
            )
          ) {
            logError(
              'DELETE_INTERACTION_REPLY',
              error
            );
          }
        }
      },
      milliseconds
    );

  timer.unref?.();
}
function scheduleFollowUpDelete(
  interaction,
  messageId,
  milliseconds =
    NOTICE_DELETE_MS
) {
  if (!messageId) {
    return;
  }

  const timer =
    setTimeout(
      async () => {
        try {
          await interaction.webhook.deleteMessage(
            messageId
          );
        } catch (error) {
          if (
            !isUnknownDiscordResource(
              error
            )
          ) {
            logError(
              'DELETE_FOLLOWUP',
              error
            );
          }
        }
      },
      milliseconds
    );

  timer.unref?.();
}

async function tempReply(
  interaction,
  content,
  type = 'info',
  milliseconds =
    NOTICE_DELETE_MS
) {
  if (
    interaction.deferred ||
    interaction.replied
  ) {
    return tempFollowUp(
      interaction,
      content,
      type,
      milliseconds
    );
  }

  try {
    await interaction.reply({
      content:
        buildNoticeText(
          content,
          type
        ),
      ephemeral:
        true
    });

    scheduleOriginalReplyDelete(
      interaction,
      milliseconds
    );

    return true;
  } catch (error) {
    if (
      !isUnknownDiscordResource(
        error
      )
    ) {
      logError(
        'TEMP_REPLY',
        error
      );
    }

    return false;
  }
}

async function tempFollowUp(
  interaction,
  content,
  type = 'info',
  milliseconds =
    NOTICE_DELETE_MS
) {
  try {
    const message =
      await interaction.followUp({
        content:
          buildNoticeText(
            content,
            type
          ),
        ephemeral:
          true,
        fetchReply:
          true
      });

    scheduleFollowUpDelete(
      interaction,
      message?.id,
      milliseconds
    );

    return message;
  } catch (error) {
    if (
      !isUnknownDiscordResource(
        error
      )
    ) {
      logError(
        'TEMP_FOLLOWUP',
        error
      );
    }

    return null;
  }
}

async function tempInteractionNotice(
  interaction,
  content,
  type = 'info',
  milliseconds =
    NOTICE_DELETE_MS
) {
  if (
    interaction.deferred ||
    interaction.replied
  ) {
    return tempFollowUp(
      interaction,
      content,
      type,
      milliseconds
    );
  }

  return tempReply(
    interaction,
    content,
    type,
    milliseconds
  );
}

async function acknowledgeComponent(
  interaction
) {
  if (
    interaction.deferred ||
    interaction.replied
  ) {
    return true;
  }

  try {
    await interaction.deferUpdate();

    return true;
  } catch (error) {
    if (
      !isUnknownDiscordResource(
        error
      )
    ) {
      logError(
        'DEFER_UPDATE',
        error
      );
    }

    return false;
  }
}

function scheduleMessageDelete(
  message,
  milliseconds =
    NOTICE_DELETE_MS
) {
  if (!message) {
    return;
  }

  const timer =
    setTimeout(
      async () => {
        await safeDeleteMessage(
          message
        );
      },
      milliseconds
    );

  timer.unref?.();
}

async function sendTemporaryChannelNotice(
  channel,
  content,
  type = 'info',
  milliseconds =
    NOTICE_DELETE_MS
) {
  if (
    !channel?.isTextBased?.()
  ) {
    return null;
  }

  try {
    const message =
      await channel.send({
        content:
          buildNoticeText(
            content,
            type
          ),
        allowedMentions: {
          parse: []
        }
      });

    scheduleMessageDelete(
      message,
      milliseconds
    );

    return message;
  } catch (error) {
    logError(
      'SEND_TEMP_NOTICE',
      error
    );

    return null;
  }
}

function getMemberVoiceChannelId(
  guild,
  memberId
) {
  if (
    !guild ||
    !memberId
  ) {
    return null;
  }

  const voiceState =
    guild.voiceStates.cache.get(
      String(memberId)
    );

  if (
    voiceState?.channelId
  ) {
    return String(
      voiceState.channelId
    );
  }

  const member =
    guild.members.cache.get(
      String(memberId)
    );

  return member?.voice?.channelId
    ? String(
        member.voice.channelId
      )
    : null;
}

async function fetchMemberWithVoiceState(
  guild,
  memberId
) {
  const member =
    await fetchMemberSafe(
      guild,
      memberId
    );

  if (!member) {
    return null;
  }

  return {
    member,
    channelId:
      getMemberVoiceChannelId(
        guild,
        member.id
      )
  };
}

async function resolveMemberInExactRoom(
  guild,
  memberId,
  channelId
) {
  const state =
    await fetchMemberWithVoiceState(
      guild,
      memberId
    );

  if (
    !state?.member ||
    state.member.user?.bot
  ) {
    return null;
  }

  if (
    String(
      state.channelId ||
      ''
    ) !==
    String(
      channelId
    )
  ) {
    return null;
  }

  return state.member;
}

async function memberIsInExactRoom(
  guild,
  memberId,
  channelId
) {
  return Boolean(
    await resolveMemberInExactRoom(
      guild,
      memberId,
      channelId
    )
  );
}

async function safeMoveMember(
  member,
  destinationChannel,
  reason
) {
  if (
    !member ||
    !isVoiceChannel(
      destinationChannel
    )
  ) {
    return false;
  }

  try {
    await member.voice.setChannel(
      destinationChannel,
      reason
    );

    return true;
  } catch (error) {
    logError(
      'MOVE_MEMBER',
      error
    );

    return false;
  }
}

async function safeDisconnectMember(
  guild,
  memberId,
  expectedChannelId,
  reason
) {
  const member =
    await resolveMemberInExactRoom(
      guild,
      memberId,
      expectedChannelId
    );

  if (!member) {
    return {
      ok: false,
      reason:
        'NOT_IN_ROOM'
    };
  }

  try {
    await member.voice.disconnect(
      reason
    );

    return {
      ok: true,
      reason:
        null
    };
  } catch (error) {
    logError(
      'DISCONNECT_MEMBER',
      error
    );

    return {
      ok: false,
      reason:
        'DISCONNECT_FAILED'
    };
  }
}

async function resolvePermissionTarget(
  channel,
  targetId
) {
  if (
    !channel?.guild ||
    !isSnowflake(
      targetId
    )
  ) {
    return null;
  }

  const id =
    String(targetId);

  if (
    id ===
    String(
      channel.guild.id
    )
  ) {
    return channel.guild.roles.everyone;
  }

  const member =
    await fetchMemberSafe(
      channel.guild,
      id
    );

  if (member) {
    return member;
  }

  const role =
    channel.guild.roles.cache.get(
      id
    );

  return role || null;
}

async function safePermissionEdit(
  channel,
  targetId,
  permissions,
  reason
) {
  const target =
    await resolvePermissionTarget(
      channel,
      targetId
    );

  if (!target) {
    return false;
  }

  try {
    await channel.permissionOverwrites.edit(
      target,
      permissions,
      {
        reason
      }
    );

    return true;
  } catch (error) {
    logError(
      'PERMISSION_EDIT',
      error
    );

    return false;
  }
}

async function safePermissionDelete(
  channel,
  targetId,
  reason
) {
  if (
    !channel?.permissionOverwrites ||
    !isSnowflake(
      targetId
    )
  ) {
    return false;
  }

  const overwrite =
    channel.permissionOverwrites.cache.get(
      String(targetId)
    );

  if (!overwrite) {
    return true;
  }

  try {
    await overwrite.delete(
      reason
    );

    return true;
  } catch (error) {
    if (
      !isUnknownDiscordResource(
        error
      )
    ) {
      logError(
        'PERMISSION_DELETE',
        error
      );
    }

    return false;
  }
}

async function grantRoomOwnerPermissions(
  channel,
  memberId
) {
  const member =
    await fetchMemberSafe(
      channel.guild,
      memberId
    );

  if (
    !member ||
    member.user?.bot
  ) {
    return false;
  }

  return safePermissionEdit(
    channel,
    member.id,
    {
      ViewChannel:
        true,
      Connect:
        true,
      Speak:
        true
    },
    `${BOT_NAME} cấp quyền chủ phòng`
  );
}

async function revokeRoomOwnerPermissions(
  channel,
  memberId
) {
  return safePermissionDelete(
    channel,
    memberId,
    `${BOT_NAME} thu hồi quyền chủ phòng cũ`
  );
}

async function grantInvitedMemberPermissions(
  channel,
  memberId
) {
  const member =
    await fetchMemberSafe(
      channel.guild,
      memberId
    );

  if (
    !member ||
    member.user?.bot
  ) {
    return false;
  }

  return safePermissionEdit(
    channel,
    member.id,
    {
      ViewChannel:
        true,
      Connect:
        true
    },
    `${BOT_NAME} cấp quyền thành viên được mời`
  );
}

async function denyMemberPermissions(
  channel,
  memberId
) {
  const member =
    await fetchMemberSafe(
      channel.guild,
      memberId
    );

  if (
    !member ||
    member.user?.bot
  ) {
    return false;
  }

  return safePermissionEdit(
    channel,
    member.id,
    {
      ViewChannel:
        false,
      Connect:
        false
    },
    `${BOT_NAME} cấm thành viên khỏi phòng`
  );
}

async function removeMemberRoomOverride(
  channel,
  memberId
) {
  return safePermissionDelete(
    channel,
    memberId,
    `${BOT_NAME} xóa quyền riêng của thành viên`
  );
}

async function clearMemberSpecificOverwrites(
  channel,
  preserveMemberIds = []
) {
  if (
    !channel?.permissionOverwrites
  ) {
    return false;
  }

  const preserve =
    new Set(
      preserveMemberIds.map(
        id =>
          String(id)
      )
    );

  const overwrites = [
    ...channel.permissionOverwrites.cache.values()
  ];

  let success =
    true;

  for (
    const overwrite
    of overwrites
  ) {
    if (
      overwrite.type !==
      OverwriteType.Member
    ) {
      continue;
    }

    if (
      preserve.has(
        String(
          overwrite.id
        )
      )
    ) {
      continue;
    }

    const deleted =
      await safePermissionDelete(
        channel,
        overwrite.id,
        `${BOT_NAME} đặt lại quyền thành viên`
      );

    if (!deleted) {
      success =
        false;
    }
  }

  return success;
}

function setSelectedMember(
  guildId,
  channelId,
  ownerId,
  memberId
) {
  const key =
    selectedMemberKey(
      guildId,
      channelId,
      ownerId
    );

  selectedMembers.set(
    key,
    {
      guildId:
        String(guildId),
      channelId:
        String(channelId),
      ownerId:
        String(ownerId),
      memberId:
        String(memberId),
      selectedAt:
        Date.now()
    }
  );
}

function getSelectedMemberState(
  guildId,
  channelId,
  ownerId
) {
  const key =
    selectedMemberKey(
      guildId,
      channelId,
      ownerId
    );

  const state =
    selectedMembers.get(
      key
    );

  if (!state) {
    return null;
  }

  if (
    Date.now() -
      state.selectedAt >
    SELECTED_MEMBER_TIMEOUT_MS
  ) {
    selectedMembers.delete(
      key
    );

    return null;
  }

  return state;
}

function getSelectedMemberId(
  guildId,
  channelId,
  ownerId
) {
  return (
    getSelectedMemberState(
      guildId,
      channelId,
      ownerId
    )?.memberId ||
    null
  );
}

function clearSelectedMember(
  guildId,
  channelId,
  ownerId
) {
  selectedMembers.delete(
    selectedMemberKey(
      guildId,
      channelId,
      ownerId
    )
  );
}

function getPendingTransfer(
  channelId
) {
  const key =
    transferKey(
      channelId
    );

  const transfer =
    pendingTransfers.get(
      key
    );

  if (!transfer) {
    return null;
  }

  if (
    transfer.expiresAt <=
    Date.now()
  ) {
    clearPendingTransfer(
      channelId
    );

    return null;
  }

  return transfer;
}

function setPendingTransfer(
  channelId,
  transfer
) {
  clearPendingTransfer(
    channelId
  );

  pendingTransfers.set(
    transferKey(
      channelId
    ),
    transfer
  );
}
async function fetchVoiceRegionsSafe(
  force = false
) {
  if (
    !force &&
    regionCache.regions.length >
      0 &&
    Date.now() -
      regionCache.fetchedAt <
      REGION_CACHE_MS
  ) {
    return regionCache.regions;
  }

  try {
    const fetched =
      await client.fetchVoiceRegions();

    const regions =
      [
        ...fetched.values()
      ]
        .filter(
          region =>
            Boolean(
              region?.id
            )
        )
        .sort(
          (
            a,
            b
          ) =>
            String(
              a.name ||
              a.id
            ).localeCompare(
              String(
                b.name ||
                b.id
              ),
              'vi'
            )
        );

    regionCache = {
      fetchedAt:
        Date.now(),
      regions
    };

    return regions;
  } catch (error) {
    logError(
      'FETCH_VOICE_REGIONS',
      error
    );

    return regionCache.regions;
  }
}

async function setVoiceRegionSafe(
  channel,
  regionId
) {
  if (
    !isVoiceChannel(
      channel
    )
  ) {
    return {
      ok: false,
      label: null
    };
  }

  const automatic =
    !regionId ||
    regionId ===
      'automatic';

  let selectedRegion =
    null;

  if (!automatic) {
    const regions =
      await fetchVoiceRegionsSafe(
        true
      );

    selectedRegion =
      regions.find(
        region =>
          String(
            region.id
          ) ===
          String(
            regionId
          )
      );

    if (!selectedRegion) {
      return {
        ok: false,
        label: null
      };
    }
  }

  try {
    await channel.setRTCRegion(
      automatic
        ? null
        : selectedRegion.id,
      `${BOT_NAME} thay đổi khu vực thoại`
    );

    const freshChannel =
      await fetchChannelSafe(
        channel.guild,
        channel.id
      );

    if (
      !isVoiceChannel(
        freshChannel
      )
    ) {
      return {
        ok: false,
        label: null
      };
    }

    if (automatic) {
      if (
        freshChannel.rtcRegion !==
        null
      ) {
        return {
          ok: false,
          label: null
        };
      }

      return {
        ok: true,
        label: 'Tự động'
      };
    }

    if (
      String(
        freshChannel.rtcRegion ||
        ''
      ) !==
      String(
        selectedRegion.id
      )
    ) {
      return {
        ok: false,
        label: null
      };
    }

    return {
      ok: true,
      label:
        cleanDisplayName(
          selectedRegion.name ||
          selectedRegion.id
        )
    };
  } catch (error) {
    logError(
      'SET_VOICE_REGION',
      error
    );

    return {
      ok: false,
      label: null
    };
  }
}

function roomNameFromMember(
  member
) {
  const name =
    cleanRoomName(
      safeMemberName(
        member
      )
    ) ||
    'Phòng thoại';

  return `${ROOM_PREFIX}${name}`
    .slice(
      0,
      100
    );
}

async function getBotMember(
  guild
) {
  if (
    !guild ||
    !client.user
  ) {
    return null;
  }

  return fetchMemberSafe(
    guild,
    client.user.id
  );
}

function missingPermissions(
  permissions,
  required
) {
  const missing = [];

  for (
    const [name, flag]
    of Object.entries(
      required
    )
  ) {
    if (
      !permissions?.has(
        flag
      )
    ) {
      missing.push(
        name
      );
    }
  }

  return missing;
}

async function validateSetupCategories(
  guild,
  buttonCategory,
  blogCategory
) {
  const botMember =
    await getBotMember(
      guild
    );

  if (!botMember) {
    return {
      ok: false,
      guildMissing: [
        'Không thể xác minh Bot'
      ],
      buttonMissing: [],
      blogMissing: []
    };
  }

  const guildRequired = {
    ManageChannels:
      PermissionsBitField.Flags.ManageChannels,

    ManageRoles:
      PermissionsBitField.Flags.ManageRoles,

    MoveMembers:
      PermissionsBitField.Flags.MoveMembers,

    Connect:
      PermissionsBitField.Flags.Connect,

    ViewChannel:
      PermissionsBitField.Flags.ViewChannel
  };

  const buttonRequired = {
    ViewChannel:
      PermissionsBitField.Flags.ViewChannel,

    ManageChannels:
      PermissionsBitField.Flags.ManageChannels,

    MoveMembers:
      PermissionsBitField.Flags.MoveMembers,

    Connect:
      PermissionsBitField.Flags.Connect
  };

  const blogRequired = {
    ViewChannel:
      PermissionsBitField.Flags.ViewChannel,

    SendMessages:
      PermissionsBitField.Flags.SendMessages,

    EmbedLinks:
      PermissionsBitField.Flags.EmbedLinks,

    ReadMessageHistory:
      PermissionsBitField.Flags.ReadMessageHistory,

    ManageChannels:
      PermissionsBitField.Flags.ManageChannels
  };

  const guildMissing =
    missingPermissions(
      botMember.permissions,
      guildRequired
    );

  const buttonMissing =
    isCategoryChannel(
      buttonCategory
    )
      ? missingPermissions(
          buttonCategory.permissionsFor(
            botMember
          ),
          buttonRequired
        )
      : [
          'Danh mục không hợp lệ'
        ];

  const blogMissing =
    isCategoryChannel(
      blogCategory
    )
      ? missingPermissions(
          blogCategory.permissionsFor(
            botMember
          ),
          blogRequired
        )
      : [
          'Danh mục không hợp lệ'
        ];

  return {
    ok:
      guildMissing.length ===
        0 &&
      buttonMissing.length ===
        0 &&
      blogMissing.length ===
        0,

    guildMissing,
    buttonMissing,
    blogMissing
  };
}

function setupPermissionErrorText(
  result
) {
  const lines = [];

  if (
    result?.guildMissing?.length
  ) {
    lines.push(
      `Server: ${result.guildMissing.join(', ')}`
    );
  }

  if (
    result?.buttonMissing?.length
  ) {
    lines.push(
      `Danh mục tạo phòng: ${result.buttonMissing.join(', ')}`
    );
  }

  if (
    result?.blogMissing?.length
  ) {
    lines.push(
      `Danh mục nhật ký: ${result.blogMissing.join(', ')}`
    );
  }

  return lines.join('\n');
}

function clearSetupSession(
  guildId,
  userId
) {
  const key =
    setupSessionKey(
      guildId,
      userId
    );

  const session =
    setupSessions.get(
      key
    );

  if (
    session?.timer
  ) {
    clearTimeout(
      session.timer
    );
  }

  setupSessions.delete(
    key
  );
}

function setSetupSession(
  guildId,
  userId,
  data = {}
) {
  clearSetupSession(
    guildId,
    userId
  );

  const key =
    setupSessionKey(
      guildId,
      userId
    );

  const session = {
    guildId:
      String(guildId),

    userId:
      String(userId),

    buttonCategoryId:
      data.buttonCategoryId
        ? String(
            data.buttonCategoryId
          )
        : null,

    blogCategoryId:
      data.blogCategoryId
        ? String(
            data.blogCategoryId
          )
        : null,

    createdAt:
      Date.now(),

    timer:
      null
  };

  const timer =
    setTimeout(
      () => {
        const current =
          setupSessions.get(
            key
          );

        if (
          current ===
          session
        ) {
          setupSessions.delete(
            key
          );
        }
      },
      SETUP_TIMEOUT_MS
    );

  timer.unref?.();

  session.timer =
    timer;

  setupSessions.set(
    key,
    session
  );

  return session;
}

function getSetupSession(
  guildId,
  userId
) {
  const key =
    setupSessionKey(
      guildId,
      userId
    );

  const session =
    setupSessions.get(
      key
    );

  if (!session) {
    return null;
  }

  if (
    Date.now() -
      session.createdAt >
    SETUP_TIMEOUT_MS
  ) {
    clearSetupSession(
      guildId,
      userId
    );

    return null;
  }

  return session;
}

function updateSetupSession(
  guildId,
  userId,
  changes
) {
  const session =
    getSetupSession(
      guildId,
      userId
    );

  if (!session) {
    return null;
  }

  Object.assign(
    session,
    changes
  );

  return session;
}

function setupOwnerMatches(
  interaction
) {
  const session =
    getSetupSession(
      interaction.guildId,
      interaction.user.id
    );

  return Boolean(
    session
  );
}

function buildSetupHomeEmbed(
  guild
) {
  return new EmbedBuilder()
    .setColor(
      UI_COLORS.blue
    )
    .setTitle(
      '⚙️ Voice HDK • Quản lý hệ thống'
    )
    .setDescription(
      [
        'Chọn thao tác bạn muốn thực hiện.',
        '',
        '**Cài đặt / Cài đặt lại**',
        'Tạo lại hệ thống Voice HDK sạch sẽ trong các danh mục bạn chọn.',
        '',
        '**Xóa toàn bộ Voice HDK**',
        'Xóa các phòng và kênh do Voice HDK đang quản lý trên Server này.',
        '',
        'Danh mục Discord của bạn sẽ **không bị xóa**.'
      ].join('\n')
    )
    .setFooter({
      text:
        `${BOT_NAME} • ${guild.name}`
    });
}

function buildSetupHomeComponents() {
  return [
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'setup_install'
          )
          .setLabel(
            'Cài đặt / Cài đặt lại'
          )
          .setEmoji(
            '⚙️'
          )
          .setStyle(
            ButtonStyle.Primary
          ),

        new ButtonBuilder()
          .setCustomId(
            'setup_uninstall'
          )
          .setLabel(
            'Xóa toàn bộ Voice HDK'
          )
          .setEmoji(
            '🗑️'
          )
          .setStyle(
            ButtonStyle.Danger
          )
      )
  ];
}

function buildSetupCategoryEmbed() {
  return new EmbedBuilder()
    .setColor(
      UI_COLORS.purple
    )
    .setTitle(
      '⚙️ Cài đặt Voice HDK'
    )
    .setDescription(
      [
        '**Bước 1:** Chọn danh mục chứa phòng thoại.',
        '**Bước 2:** Chọn danh mục chứa nhật ký.',
        '**Bước 3:** Nhấn **Tiếp tục**.',
        '',
        'Voice HDK sẽ không xóa hai danh mục này.',
        '',
        '`➕ Tạo phòng` sẽ được đặt ở đầu danh mục phòng thoại.'
      ].join('\n')
    );
}

function buildSetupCategoryComponents(
  session
) {
  const buttonCategory =
    new ChannelSelectMenuBuilder()
      .setCustomId(
        'setup_button_category'
      )
      .setPlaceholder(
        session?.buttonCategoryId
          ? '✅ Đã chọn danh mục phòng thoại'
          : '🔊 Chọn danh mục phòng thoại'
      )
      .setChannelTypes(
        ChannelType.GuildCategory
      )
      .setMinValues(1)
      .setMaxValues(1);

  const blogCategory =
    new ChannelSelectMenuBuilder()
      .setCustomId(
        'setup_blog_category'
      )
      .setPlaceholder(
        session?.blogCategoryId
          ? '✅ Đã chọn danh mục nhật ký'
          : '📝 Chọn danh mục nhật ký'
      )
      .setChannelTypes(
        ChannelType.GuildCategory
      )
      .setMinValues(1)
      .setMaxValues(1);

  const continueButton =
    new ButtonBuilder()
      .setCustomId(
        'setup_continue'
      )
      .setLabel(
        'Tiếp tục'
      )
      .setEmoji(
        '➡️'
      )
      .setStyle(
        ButtonStyle.Success
      )
      .setDisabled(
        !session?.buttonCategoryId ||
        !session?.blogCategoryId
      );

  const cancelButton =
    new ButtonBuilder()
      .setCustomId(
        'setup_cancel'
      )
      .setLabel(
        'Hủy'
      )
      .setEmoji(
        '✖️'
      )
      .setStyle(
        ButtonStyle.Danger
      );

  return [
    new ActionRowBuilder()
      .addComponents(
        buttonCategory
      ),

    new ActionRowBuilder()
      .addComponents(
        blogCategory
      ),

    new ActionRowBuilder()
      .addComponents(
        continueButton,
        cancelButton
      )
  ];
}

function buildUninstallConfirmEmbed() {
  return new EmbedBuilder()
    .setColor(
      UI_COLORS.orange
    )
    .setTitle(
      '🗑️ Xác nhận xóa Voice HDK'
    )
    .setDescription(
      [
        'Thao tác này sẽ xóa toàn bộ tài nguyên **đang được Voice HDK theo dõi** trên Server này:',
        '',
        '• `➕ Tạo phòng`',
        '• Toàn bộ phòng tạm `🔊・...` do bot quản lý',
        '• `💬・nhật-ký-chat`',
        '• `⚙️・nhật-ký-chức-năng`',
        '• Panel và dữ liệu phòng',
        '• Dữ liệu mời / cấm',
        '• Dữ liệu chủ phòng',
        '• Dữ liệu chuyển chủ và vắng mặt',
        '• Cấu hình Voice HDK trong PostgreSQL',
        '',
        '**Không xóa Category Discord bạn đã chọn.**',
        '**Không xóa channel không thuộc dữ liệu quản lý của Voice HDK.**'
      ].join('\n')
    );
}

function buildUninstallConfirmComponents() {
  return [
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'setup_uninstall_confirm'
          )
          .setLabel(
            'Xác nhận xóa'
          )
          .setEmoji(
            '🗑️'
          )
          .setStyle(
            ButtonStyle.Danger
          ),

        new ButtonBuilder()
          .setCustomId(
            'setup_uninstall_cancel'
          )
          .setLabel(
            'Không xóa'
          )
          .setEmoji(
            '↩️'
          )
          .setStyle(
            ButtonStyle.Primary
          )
      )
  ];
}

async function userCanManageSetup(
  interaction
) {
  if (
    !interaction.inGuild()
  ) {
    return false;
  }

  const member =
    await fetchMemberSafe(
      interaction.guild,
      interaction.user.id
    );

  if (!member) {
    return false;
  }

  return (
    member.permissions.has(
      PermissionsBitField.Flags.ManageGuild
    ) ||
    member.permissions.has(
      PermissionsBitField.Flags.Administrator
    )
  );
}

async function handleSetupCommand(
  interaction
) {
  if (
    !interaction.inGuild()
  ) {
    return tempReply(
      interaction,
      'Lệnh này chỉ sử dụng trong Server.',
      'warning'
    );
  }

  const allowed =
    await userCanManageSetup(
      interaction
    );

  if (!allowed) {
    return tempReply(
      interaction,
      'Bạn cần quyền Quản lý máy chủ để sử dụng /setup.',
      'warning'
    );
  }

  clearSetupSession(
    interaction.guildId,
    interaction.user.id
  );

  await interaction.reply({
    embeds: [
      buildSetupHomeEmbed(
        interaction.guild
      )
    ],

    components:
      buildSetupHomeComponents(),

    ephemeral:
      true
  });
}

async function handleSetupInstallButton(
  interaction
) {
  const allowed =
    await userCanManageSetup(
      interaction
    );

  if (!allowed) {
    return tempInteractionNotice(
      interaction,
      'Bạn không có quyền cài đặt Voice HDK.',
      'warning'
    );
  }

  const session =
    setSetupSession(
      interaction.guildId,
      interaction.user.id
    );

  await interaction.update({
    embeds: [
      buildSetupCategoryEmbed()
    ],

    components:
      buildSetupCategoryComponents(
        session
      )
  });
}

async function handleSetupButtonCategory(
  interaction
) {
  const session =
    getSetupSession(
      interaction.guildId,
      interaction.user.id
    );

  if (!session) {
    return tempInteractionNotice(
      interaction,
      'Phiên cài đặt đã hết hạn. Hãy dùng /setup lại.',
      'warning'
    );
  }

  const categoryId =
    interaction.values?.[0];

  const category =
    await fetchChannelSafe(
      interaction.guild,
      categoryId
    );

  if (
    !isCategoryChannel(
      category
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Danh mục phòng thoại không hợp lệ.',
      'warning'
    );
  }

  updateSetupSession(
    interaction.guildId,
    interaction.user.id,
    {
      buttonCategoryId:
        category.id
    }
  );

  const updated =
    getSetupSession(
      interaction.guildId,
      interaction.user.id
    );

  await interaction.update({
    embeds: [
      buildSetupCategoryEmbed()
    ],

    components:
      buildSetupCategoryComponents(
        updated
      )
  });
}
async function handleSetupBlogCategory(
  interaction
) {
  const session =
    getSetupSession(
      interaction.guildId,
      interaction.user.id
    );

  if (!session) {
    return tempInteractionNotice(
      interaction,
      'Phiên cài đặt đã hết hạn. Hãy dùng /setup lại.',
      'warning'
    );
  }

  const categoryId =
    interaction.values?.[0];

  const category =
    await fetchChannelSafe(
      interaction.guild,
      categoryId
    );

  if (
    !isCategoryChannel(
      category
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Danh mục nhật ký không hợp lệ.',
      'warning'
    );
  }

  updateSetupSession(
    interaction.guildId,
    interaction.user.id,
    {
      blogCategoryId:
        category.id
    }
  );

  const updated =
    getSetupSession(
      interaction.guildId,
      interaction.user.id
    );

  await interaction.update({
    embeds: [
      buildSetupCategoryEmbed()
    ],

    components:
      buildSetupCategoryComponents(
        updated
      )
  });
}

async function handleSetupContinue(
  interaction
) {
  const session =
    getSetupSession(
      interaction.guildId,
      interaction.user.id
    );

  if (!session) {
    return tempInteractionNotice(
      interaction,
      'Phiên cài đặt đã hết hạn. Hãy dùng /setup lại.',
      'warning'
    );
  }

  if (
    !session.buttonCategoryId ||
    !session.blogCategoryId
  ) {
    return tempInteractionNotice(
      interaction,
      'Hãy chọn đủ hai danh mục trước.',
      'warning'
    );
  }

  const modal =
    new ModalBuilder()
      .setCustomId(
        'setup_display_name_modal'
      )
      .setTitle(
        'Tên hiển thị Voice HDK'
      );

  const input =
    new TextInputBuilder()
      .setCustomId(
        'setup_display_name'
      )
      .setLabel(
        'Tên hiển thị của Server'
      )
      .setPlaceholder(
        'Ví dụ: HDK Community'
      )
      .setStyle(
        TextInputStyle.Short
      )
      .setMinLength(1)
      .setMaxLength(80)
      .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder()
      .addComponents(
        input
      )
  );

  await interaction.showModal(
    modal
  );
}

async function handleSetupCancel(
  interaction
) {
  clearSetupSession(
    interaction.guildId,
    interaction.user.id
  );

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(
          UI_COLORS.orange
        )
        .setTitle(
          'Đã hủy cài đặt'
        )
        .setDescription(
          'Không có thay đổi nào được thực hiện.'
        )
    ],

    components: []
  });
}

async function handleSetupUninstallButton(
  interaction
) {
  const allowed =
    await userCanManageSetup(
      interaction
    );

  if (!allowed) {
    return tempInteractionNotice(
      interaction,
      'Bạn không có quyền xóa Voice HDK.',
      'warning'
    );
  }

  clearSetupSession(
    interaction.guildId,
    interaction.user.id
  );

  await interaction.update({
    embeds: [
      buildUninstallConfirmEmbed()
    ],

    components:
      buildUninstallConfirmComponents()
  });
}

async function handleSetupUninstallCancel(
  interaction
) {
  await interaction.update({
    embeds: [
      buildSetupHomeEmbed(
        interaction.guild
      )
    ],

    components:
      buildSetupHomeComponents()
  });
}

function uniqueTrackedChannelIds(
  generator,
  rooms
) {
  const ids =
    new Set();

  for (
    const room
    of rooms
  ) {
    if (
      isSnowflake(
        room.channel_id
      )
    ) {
      ids.add(
        String(
          room.channel_id
        )
      );
    }
  }

  if (
    isSnowflake(
      generator?.create_voice_id
    )
  ) {
    ids.add(
      String(
        generator.create_voice_id
      )
    );
  }

  if (
    isSnowflake(
      generator?.chat_log_channel_id
    )
  ) {
    ids.add(
      String(
        generator.chat_log_channel_id
      )
    );
  }

  if (
    isSnowflake(
      generator?.action_log_channel_id
    )
  ) {
    ids.add(
      String(
        generator.action_log_channel_id
      )
    );
  }

  return [
    ...ids
  ];
}

async function deleteTrackedManagedChannels(
  guild,
  channelIds
) {
  const failed = [];

  for (
    const channelId
    of channelIds
  ) {
    const channel =
      await fetchChannelSafe(
        guild,
        channelId
      );

    if (!channel) {
      continue;
    }

    const deleted =
      await safeDeleteChannel(
        channel,
        `${BOT_NAME} dọn tài nguyên được quản lý`
      );

    if (!deleted) {
      failed.push(
        channelId
      );
    }
  }

  return failed;
}

async function deleteGuildDatabaseConfiguration(
  guildId
) {
  const db =
    await pool.connect();

  try {
    await db.query(
      'BEGIN'
    );

    await deleteGuildVoiceData(
      guildId,
      db
    );

    await deleteGenerator(
      guildId,
      db
    );

    await db.query(
      'COMMIT'
    );

    return true;
  } catch (error) {
    await db.query(
      'ROLLBACK'
    ).catch(
      () => {}
    );

    logError(
      'DELETE_GUILD_DATABASE',
      error
    );

    return false;
  } finally {
    db.release();
  }
}

async function cleanupManagedGuild(
  guild
) {
  const guildId =
    String(
      guild.id
    );

  if (
    setupCleanupGuilds.has(
      guildId
    )
  ) {
    return {
      ok: false,
      busy: true,
      failedChannelIds: []
    };
  }

  setupCleanupGuilds.add(
    guildId
  );

  try {
    const generator =
      await getGenerator(
        guildId
      );

    const rooms =
      await getGuildRooms(
        guildId
      );

    const channelIds =
      uniqueTrackedChannelIds(
        generator,
        rooms
      );

    for (
      const room
      of rooms
    ) {
      clearRoomRuntimeState(
        room.channel_id
      );
    }

    clearGuildRuntimeState(
      guildId
    );

    const failedChannelIds =
      await deleteTrackedManagedChannels(
        guild,
        channelIds
      );

    if (
      failedChannelIds.length >
      0
    ) {
      return {
        ok: false,
        busy: false,
        failedChannelIds
      };
    }

    const databaseDeleted =
      await deleteGuildDatabaseConfiguration(
        guildId
      );

    if (!databaseDeleted) {
      return {
        ok: false,
        busy: false,
        failedChannelIds: []
      };
    }

    return {
      ok: true,
      busy: false,
      failedChannelIds: []
    };
  } catch (error) {
    logError(
      'CLEANUP_MANAGED_GUILD',
      error
    );

    return {
      ok: false,
      busy: false,
      failedChannelIds: []
    };
  } finally {
    setupCleanupGuilds.delete(
      guildId
    );
  }
}

async function positionGeneratorFirst(
  generatorChannel
) {
  if (
    !isVoiceChannel(
      generatorChannel
    )
  ) {
    return false;
  }

  try {
    await generatorChannel.setPosition(
      0,
      {
        reason:
          `${BOT_NAME} đặt kênh tạo phòng ở đầu danh mục`
      }
    );

    return true;
  } catch (error) {
    logError(
      'POSITION_GENERATOR',
      error
    );

    return false;
  }
}

async function createManagedGenerator(
  guild,
  category
) {
  if (
    !isCategoryChannel(
      category
    )
  ) {
    return null;
  }

  try {
    const channel =
      await guild.channels.create({
        name:
          CREATE_VOICE_NAME,

        type:
          ChannelType.GuildVoice,

        parent:
          category.id,

        reason:
          `${BOT_NAME} tạo kênh tạo phòng`
      });

    await positionGeneratorFirst(
      channel
    );

    return channel;
  } catch (error) {
    logError(
      'CREATE_GENERATOR',
      error
    );

    return null;
  }
}

async function createManagedLogChannel(
  guild,
  category,
  name
) {
  if (
    !isCategoryChannel(
      category
    )
  ) {
    return null;
  }

  try {
    return await guild.channels.create({
      name,

      type:
        ChannelType.GuildText,

      parent:
        category.id,

      reason:
        `${BOT_NAME} tạo kênh nhật ký`
    });
  } catch (error) {
    logError(
      'CREATE_LOG_CHANNEL',
      error
    );

    return null;
  }
}

async function rollbackNewSetupChannels(
  channels
) {
  for (
    const channel
    of channels
      .filter(Boolean)
      .reverse()
  ) {
    await safeDeleteChannel(
      channel,
      `${BOT_NAME} hoàn tác cài đặt không hoàn chỉnh`
    );
  }
}

async function installVoiceHDK(
  guild,
  buttonCategory,
  blogCategory,
  displayName
) {
  const guildId =
    String(
      guild.id
    );

  if (
    setupCleanupGuilds.has(
      guildId
    )
  ) {
    return {
      ok: false,
      reason:
        'BUSY'
    };
  }

  const permissions =
    await validateSetupCategories(
      guild,
      buttonCategory,
      blogCategory
    );

  if (
    !permissions.ok
  ) {
    return {
      ok: false,
      reason:
        'PERMISSIONS',
      permissions
    };
  }

  const cleanup =
    await cleanupManagedGuild(
      guild
    );

  if (!cleanup.ok) {
    return {
      ok: false,
      reason:
        cleanup.busy
          ? 'BUSY'
          : 'CLEANUP_FAILED',
      failedChannelIds:
        cleanup.failedChannelIds ||
        []
    };
  }

  const created = [];

  try {
    const generatorChannel =
      await createManagedGenerator(
        guild,
        buttonCategory
      );

    if (!generatorChannel) {
      throw new Error(
        'CREATE_GENERATOR_FAILED'
      );
    }

    created.push(
      generatorChannel
    );

    const chatLogChannel =
      await createManagedLogChannel(
        guild,
        blogCategory,
        CHAT_LOG_CHANNEL_NAME
      );

    if (!chatLogChannel) {
      throw new Error(
        'CREATE_CHAT_LOG_FAILED'
      );
    }

    created.push(
      chatLogChannel
    );

    const actionLogChannel =
      await createManagedLogChannel(
        guild,
        blogCategory,
        ACTION_LOG_CHANNEL_NAME
      );

    if (!actionLogChannel) {
      throw new Error(
        'CREATE_ACTION_LOG_FAILED'
      );
    }

    created.push(
      actionLogChannel
    );

    const saved =
      await saveGenerator({
        guildId:
          guild.id,

        displayName,

        buttonCategoryId:
          buttonCategory.id,

        blogCategoryId:
          blogCategory.id,

        createVoiceId:
          generatorChannel.id,

        chatLogChannelId:
          chatLogChannel.id,

        actionLogChannelId:
          actionLogChannel.id
      });

    if (!saved) {
      throw new Error(
        'SAVE_GENERATOR_FAILED'
      );
    }

    await positionGeneratorFirst(
      generatorChannel
    );

    return {
      ok: true,
      generator:
        saved,
      generatorChannel,
      chatLogChannel,
      actionLogChannel
    };
  } catch (error) {
    logError(
      'INSTALL_VOICE_HDK',
      error
    );

    await rollbackNewSetupChannels(
      created
    );

    await deleteGuildDatabaseConfiguration(
      guildId
    ).catch(
      () => {}
    );

    return {
      ok: false,
      reason:
        'INSTALL_FAILED'
    };
  }
}

async function handleSetupDisplayNameModal(
  interaction
) {
  const session =
    getSetupSession(
      interaction.guildId,
      interaction.user.id
    );

  if (!session) {
    return tempReply(
      interaction,
      'Phiên cài đặt đã hết hạn. Hãy dùng /setup lại.',
      'warning'
    );
  }

  const displayName =
    cleanDisplayName(
      interaction.fields.getTextInputValue(
        'setup_display_name'
      )
    );

  if (!displayName) {
    return tempReply(
      interaction,
      'Tên hiển thị không hợp lệ.',
      'warning'
    );
  }

  const buttonCategory =
    await fetchChannelSafe(
      interaction.guild,
      session.buttonCategoryId
    );

  const blogCategory =
    await fetchChannelSafe(
      interaction.guild,
      session.blogCategoryId
    );

  if (
    !isCategoryChannel(
      buttonCategory
    ) ||
    !isCategoryChannel(
      blogCategory
    )
  ) {
    clearSetupSession(
      interaction.guildId,
      interaction.user.id
    );

    return tempReply(
      interaction,
      'Một trong hai danh mục đã bị xóa hoặc không còn hợp lệ. Hãy dùng /setup lại.',
      'error'
    );
  }

  await interaction.deferReply({
    ephemeral:
      true
  });

  const result =
    await installVoiceHDK(
      interaction.guild,
      buttonCategory,
      blogCategory,
      displayName
    );

  clearSetupSession(
    interaction.guildId,
    interaction.user.id
  );

  if (!result.ok) {
    let message =
      'Không thể hoàn tất cài đặt Voice HDK.';

    if (
      result.reason ===
      'PERMISSIONS'
    ) {
      const detail =
        setupPermissionErrorText(
          result.permissions
        );

      message = [
        'Bot đang thiếu quyền cần thiết.',
        detail
      ]
        .filter(Boolean)
        .join('\n');
    }

    if (
      result.reason ===
      'CLEANUP_FAILED'
    ) {
      message =
        result.failedChannelIds?.length
          ? `Không thể xóa ${result.failedChannelIds.length} kênh Voice HDK cũ. Bot đã dừng cài lại để tránh bỏ sót dữ liệu.`
          : 'Không thể dọn sạch cấu hình Voice HDK cũ. Bot đã dừng cài lại để tránh dữ liệu bị lệch.';
    }

    if (
      result.reason ===
      'BUSY'
    ) {
      message =
        'Voice HDK đang thực hiện một thao tác cài đặt hoặc dọn dẹp khác. Hãy thử lại sau.';
    }

    await interaction.editReply({
      content:
        buildNoticeText(
          message,
          'error'
        )
    });

    scheduleOriginalReplyDelete(
      interaction
    );

    return;
  }

  await interaction.editReply({
    content:
      [
        '🟢 **Cài đặt Voice HDK thành công.**',
        '',
        `🔊 ${CREATE_VOICE_NAME}`,
        `💬 ${CHAT_LOG_CHANNEL_NAME}`,
        `⚙️ ${ACTION_LOG_CHANNEL_NAME}`,
        '',
        `🏷️ Tên hiển thị: **${displayName}**`,
        '',
        '**Huỳnh Duy Khánh • 0988850044**'
      ].join('\n')
  });

  scheduleOriginalReplyDelete(
    interaction
  );
}
async function handleSetupUninstallConfirm(
  interaction
) {
  const allowed =
    await userCanManageSetup(
      interaction
    );

  if (!allowed) {
    return tempInteractionNotice(
      interaction,
      'Bạn không có quyền xóa Voice HDK.',
      'warning'
    );
  }

  await interaction.deferUpdate();

  const result =
    await cleanupManagedGuild(
      interaction.guild
    );

  if (!result.ok) {
    let message =
      'Không thể xóa toàn bộ Voice HDK.';

    if (
      result.busy
    ) {
      message =
        'Voice HDK đang thực hiện một thao tác quản lý khác. Hãy thử lại sau.';
    } else if (
      result.failedChannelIds?.length
    ) {
      message =
        `Không thể xóa ${result.failedChannelIds.length} kênh đang được Voice HDK quản lý. Dữ liệu PostgreSQL được giữ lại để bot không mất dấu các kênh này.`;
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(
            UI_COLORS.orange
          )
          .setTitle(
            '⚠️ Chưa thể xóa hoàn toàn'
          )
          .setDescription(
            message
          )
      ],

      components:
        buildSetupHomeComponents()
    });

    return;
  }

  clearSetupSession(
    interaction.guildId,
    interaction.user.id
  );

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(
          UI_COLORS.green
        )
        .setTitle(
          '✅ Đã xóa Voice HDK'
        )
        .setDescription(
          [
            'Đã xóa toàn bộ tài nguyên Voice HDK được theo dõi trên Server này.',
            '',
            'Các Category Discord của bạn được giữ nguyên.',
            'Các channel không thuộc Voice HDK không bị xóa.',
            '',
            'Muốn sử dụng lại, hãy chạy `/setup`.'
          ].join('\n')
        )
    ],

    components: []
  });
}

function unicodeDisplayWidth(
  value
) {
  let width = 0;

  for (
    const char
    of String(
      value || ''
    )
  ) {
    const code =
      char.codePointAt(0);

    if (
      code >= 0x1100 &&
      (
        code <= 0x115f ||
        code === 0x2329 ||
        code === 0x232a ||
        (
          code >= 0x2e80 &&
          code <= 0xa4cf &&
          code !== 0x303f
        ) ||
        (
          code >= 0xac00 &&
          code <= 0xd7a3
        ) ||
        (
          code >= 0xf900 &&
          code <= 0xfaff
        ) ||
        (
          code >= 0xfe10 &&
          code <= 0xfe19
        ) ||
        (
          code >= 0xfe30 &&
          code <= 0xfe6f
        ) ||
        (
          code >= 0xff00 &&
          code <= 0xff60
        ) ||
        (
          code >= 0xffe0 &&
          code <= 0xffe6
        ) ||
        (
          code >= 0x1f300 &&
          code <= 0x1faff
        )
      )
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }

  return width;
}

function truncateDisplayText(
  value,
  maxWidth
) {
  const text =
    String(
      value || ''
    );

  if (
    unicodeDisplayWidth(
      text
    ) <= maxWidth
  ) {
    return text;
  }

  let result = '';

  for (
    const char
    of text
  ) {
    const candidate =
      `${result}${char}…`;

    if (
      unicodeDisplayWidth(
        candidate
      ) >
      maxWidth
    ) {
      break;
    }

    result += char;
  }

  return `${result}…`;
}

function centerDisplayText(
  value,
  frameWidth = 38
) {
  const text =
    truncateDisplayText(
      value,
      frameWidth
    );

  const width =
    unicodeDisplayWidth(
      text
    );

  const remaining =
    Math.max(
      0,
      frameWidth -
        width
    );

  const left =
    Math.floor(
      remaining / 2
    );

  const right =
    remaining -
      left;

  return (
    `${' '.repeat(left)}` +
    text +
    `${' '.repeat(right)}`
  );
}

function roomFrameLine(
  width = 38
) {
  return '─'.repeat(
    width
  );
}

function getEveryoneOverwrite(
  channel
) {
  if (
    !channel?.guild
  ) {
    return null;
  }

  return (
    channel.permissionOverwrites.cache.get(
      String(
        channel.guild.id
      )
    ) ||
    null
  );
}

function roomIsLocked(
  channel
) {
  const overwrite =
    getEveryoneOverwrite(
      channel
    );

  return Boolean(
    overwrite?.deny?.has(
      PermissionsBitField.Flags.Connect
    )
  );
}

function roomIsHidden(
  channel
) {
  const overwrite =
    getEveryoneOverwrite(
      channel
    );

  return Boolean(
    overwrite?.deny?.has(
      PermissionsBitField.Flags.ViewChannel
    )
  );
}

function roomRegionLabel(
  channel,
  regions = []
) {
  if (
    !channel?.rtcRegion
  ) {
    return 'Tự động';
  }

  const region =
    regions.find(
      item =>
        String(
          item.id
        ) ===
        String(
          channel.rtcRegion
        )
    );

  return cleanDisplayName(
    region?.name ||
      channel.rtcRegion
  );
}

function roomLimitLabel(
  channel
) {
  const limit =
    Number(
      channel?.userLimit ||
      0
    );

  return limit > 0
    ? String(limit)
    : '∞';
}

function roomHumanCount(
  channel
) {
  return humanMembers(
    channel
  ).length;
}

async function buildRoomPanelContent(
  channel,
  room,
  generator
) {
  const owner =
    await fetchMemberSafe(
      channel.guild,
      room.owner_id
    );

  const regions =
    await fetchVoiceRegionsSafe();

  const rawRoomName =
    cleanRoomName(
      channel.name
    ) ||
    'PHÒNG THOẠI';

  const title =
    `🔊  PHÒNG CỦA ${rawRoomName.toUpperCase()}`;

  const displayName =
    cleanDisplayName(
      generator?.display_name
    ) ||
    BOT_NAME;

  const footer =
    `✦ ${BOT_NAME} • ${displayName}`;

  const ownerText =
    owner
      ? `<@${owner.id}>`
      : 'Không xác định';

  const memberCount =
    roomHumanCount(
      channel
    );

  const locked =
    roomIsLocked(
      channel
    );

  const hidden =
    roomIsHidden(
      channel
    );

  const region =
    roomRegionLabel(
      channel,
      regions
    );

  const width = 38;

  return [
    centerDisplayText(
      title,
      width
    ),

    roomFrameLine(
      width
    ),

    `👑 Chủ phòng ${ownerText}`,

    `👥 Thành viên ${memberCount} / ${roomLimitLabel(
      channel
    )}`,

    `🔒 Phòng ${
      locked
        ? 'Đang khóa'
        : 'Đang mở'
    }`,

    `👁 Hiển thị ${
      hidden
        ? 'Riêng tư'
        : 'Công khai'
    }`,

    `🌐 Khu vực ${region}`,

    roomFrameLine(
      width
    ),

    centerDisplayText(
      footer,
      width
    )
  ].join('\n');
}

async function buildRoomPanelComponents(
  channel,
  room
) {
  const locked =
    roomIsLocked(
      channel
    );

  const hidden =
    roomIsHidden(
      channel
    );

  const selectedId =
    getSelectedMemberId(
      channel.guild.id,
      channel.id,
      room.owner_id
    );

  const rowOne =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'room_lock'
          )
          .setLabel(
            locked
              ? 'Mở phòng'
              : 'Khóa phòng'
          )
          .setEmoji(
            locked
              ? '🔓'
              : '🔒'
          )
          .setStyle(
            locked
              ? ButtonStyle.Success
              : ButtonStyle.Danger
          ),

        new ButtonBuilder()
          .setCustomId(
            'room_hide'
          )
          .setLabel(
            hidden
              ? 'Hiện phòng'
              : 'Ẩn phòng'
          )
          .setEmoji(
            hidden
              ? '👁️'
              : '🙈'
          )
          .setStyle(
            hidden
              ? ButtonStyle.Success
              : ButtonStyle.Primary
          ),

        new ButtonBuilder()
          .setCustomId(
            'room_rename'
          )
          .setLabel(
            'Đổi tên'
          )
          .setEmoji(
            '✏️'
          )
          .setStyle(
            ButtonStyle.Primary
          )
      );

  const rowTwo =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'room_reset'
          )
          .setLabel(
            'Đặt lại'
          )
          .setEmoji(
            '♻️'
          )
          .setStyle(
            ButtonStyle.Primary
          ),

        new ButtonBuilder()
          .setCustomId(
            'room_limit'
          )
          .setLabel(
            'Giới hạn'
          )
          .setEmoji(
            '👥'
          )
          .setStyle(
            ButtonStyle.Primary
          ),

        new ButtonBuilder()
          .setCustomId(
            'room_invite'
          )
          .setLabel(
            'Mời'
          )
          .setEmoji(
            '📨'
          )
          .setStyle(
            ButtonStyle.Success
          )
      );

  const rowThree =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'room_transfer'
          )
          .setLabel(
            'Chuyển chủ'
          )
          .setEmoji(
            '👑'
          )
          .setStyle(
            ButtonStyle.Primary
          ),

        new ButtonBuilder()
          .setCustomId(
            'room_deny'
          )
          .setLabel(
            'Cấm'
          )
          .setEmoji(
            '⛔'
          )
          .setStyle(
            ButtonStyle.Danger
          ),

        new ButtonBuilder()
          .setCustomId(
            'room_kick'
          )
          .setLabel(
            'Đuổi'
          )
          .setEmoji(
            '👢'
          )
          .setStyle(
            ButtonStyle.Danger
          )
      );

  const memberSelect =
    new UserSelectMenuBuilder()
      .setCustomId(
        'room_member_select'
      )
      .setPlaceholder(
        '👤 Chọn thành viên'
      )
      .setMinValues(1)
      .setMaxValues(1);

  if (
    selectedId &&
    isSnowflake(
      selectedId
    )
  ) {
    try {
      memberSelect.setDefaultUsers(
        selectedId
      );
    } catch (error) {
      logError(
        'SET_DEFAULT_USER',
        error
      );
    }
  }

  const rowFour =
    new ActionRowBuilder()
      .addComponents(
        memberSelect
      );

  const regions =
    await fetchVoiceRegionsSafe();

  const regionMenu =
    new StringSelectMenuBuilder()
      .setCustomId(
        'room_region'
      )
      .setPlaceholder(
        '🌐 Chọn khu vực thoại'
      )
      .setMinValues(1)
      .setMaxValues(1);

  const regionOptions = [
    {
      label:
        'Tự động',
      value:
        'automatic',
      description:
        'Để Discord tự chọn khu vực phù hợp',
      emoji:
        '🌐',
      default:
        !channel.rtcRegion
    }
  ];

  for (
    const region
    of regions.slice(
      0,
      24
    )
  ) {
    const id =
      String(
        region.id
      );

    regionOptions.push({
      label:
        cleanDisplayName(
          region.name ||
          id
        ).slice(
          0,
          100
        ),

      value:
        id.slice(
          0,
          100
        ),

      description:
        region.deprecated
          ? 'Khu vực Discord cũ'
          : 'Khu vực thoại Discord',

      default:
        String(
          channel.rtcRegion ||
          ''
        ) === id
    });
  }

  regionMenu.addOptions(
    regionOptions
  );

  const rowFive =
    new ActionRowBuilder()
      .addComponents(
        regionMenu
      );

  return [
    rowOne,
    rowTwo,
    rowThree,
    rowFour,
    rowFive
  ];
}

function isRoomControlMessage(
  message
) {
  if (
    !message ||
    !client.user
  ) {
    return false;
  }

  if (
    String(
      message.author?.id ||
      ''
    ) !==
    String(
      client.user.id
    )
  ) {
    return false;
  }

  for (
    const row
    of message.components ||
    []
  ) {
    for (
      const component
      of row.components ||
      []
    ) {
      if (
        component.customId ===
          'room_lock' ||
        component.customId ===
          'room_member_select' ||
        component.customId ===
          'room_region'
      ) {
        return true;
      }
    }
  }

  return false;
}

async function findRoomControlMessages(
  channel
) {
  if (
    !channel?.messages?.fetch
  ) {
    return [];
  }

  try {
    const messages =
      await channel.messages.fetch({
        limit: 50
      });

    return [
      ...messages.values()
    ]
      .filter(
        message =>
          isRoomControlMessage(
            message
          )
      )
      .sort(
        (
          a,
          b
        ) =>
          b.createdTimestamp -
          a.createdTimestamp
      );
  } catch (error) {
    logError(
      'SCAN_ROOM_PANEL',
      error
    );

    return [];
  }
}

async function deleteDuplicateRoomPanels(
  messages,
  keepMessageId
) {
  for (
    const message
    of messages
  ) {
    if (
      String(
        message.id
      ) ===
      String(
        keepMessageId
      )
    ) {
      continue;
    }

    await safeDeleteMessage(
      message
    );
  }
}

async function renderRoomPanelPayload(
  channel,
  room
) {
  const generator =
    await getGenerator(
      channel.guild.id
    );

  return {
    content:
      await buildRoomPanelContent(
        channel,
        room,
        generator
      ),

    components:
      await buildRoomPanelComponents(
        channel,
        room
      ),

    allowedMentions: {
      parse: []
    }
  };
}

async function ensureRoomPanel(
  channelId
) {
  return withPanelLock(
    channelId,
    async () => {
      const room =
        await getRoom(
          channelId
        );

      if (!room) {
        return null;
      }

      const guild =
        client.guilds.cache.get(
          String(
            room.guild_id
          )
        );

      if (!guild) {
        return null;
      }

      const channel =
        await fetchChannelSafe(
          guild,
          channelId
        );

      if (
        !isVoiceChannel(
          channel
        )
      ) {
        return null;
      }

      const payload =
        await renderRoomPanelPayload(
          channel,
          room
        );

      let panelMessage =
        null;

      if (
        isSnowflake(
          room.control_message_id
        )
      ) {
        const stored =
          await fetchMessageSafe(
            channel,
            room.control_message_id
          );

        if (
          stored &&
          isRoomControlMessage(
            stored
          )
        ) {
          try {
            panelMessage =
              await stored.edit(
                payload
              );
          } catch (error) {
            logError(
              'EDIT_STORED_PANEL',
              error
            );
          }
        }
      }

      const discovered =
        await findRoomControlMessages(
          channel
        );

      if (!panelMessage) {
        const newest =
          discovered[0];

        if (newest) {
          try {
            panelMessage =
              await newest.edit(
                payload
              );
          } catch (error) {
            logError(
              'ADOPT_ROOM_PANEL',
              error
            );
          }
        }
      }

      if (!panelMessage) {
        try {
          panelMessage =
            await channel.send(
              payload
            );
        } catch (error) {
          logError(
            'CREATE_ROOM_PANEL',
            error
          );

          return null;
        }
      }

      if (
        String(
          room.control_message_id ||
          ''
        ) !==
        String(
          panelMessage.id
        )
      ) {
        await setControlMessage(
          channel.id,
          panelMessage.id
        );
      }

      const allPanels =
        await findRoomControlMessages(
          channel
        );

      await deleteDuplicateRoomPanels(
        allPanels,
        panelMessage.id
      );

      return panelMessage;
    }
  );
}

async function refreshRoomPanelSafe(
  channelId
) {
  try {
    return await ensureRoomPanel(
      channelId
    );
  } catch (error) {
    logError(
      'REFRESH_ROOM_PANEL',
      error
    );

    return null;
  }
}

async function resetSelectedMemberAndPanel(
  guildId,
  channelId,
  ownerId
) {
  clearSelectedMember(
    guildId,
    channelId,
    ownerId
  );

  return refreshRoomPanelSafe(
    channelId
  );
}
async function getManagedRoomContext(
  interaction
) {
  if (
    !interaction.inGuild() ||
    !interaction.channelId
  ) {
    return null;
  }

  const room =
    await getRoom(
      interaction.channelId
    );

  if (
    !room ||
    String(
      room.guild_id
    ) !==
    String(
      interaction.guildId
    )
  ) {
    return null;
  }

  const channel =
    await fetchChannelSafe(
      interaction.guild,
      room.channel_id
    );

  if (
    !isVoiceChannel(
      channel
    )
  ) {
    return null;
  }

  return {
    room,
    channel
  };
}

async function getOwnerRoomContext(
  interaction
) {
  const context =
    await getManagedRoomContext(
      interaction
    );

  if (!context) {
    await tempInteractionNotice(
      interaction,
      'Đây không phải phòng đang được Voice HDK quản lý.',
      'warning'
    );

    return null;
  }

  if (
    String(
      context.room.owner_id
    ) !==
    String(
      interaction.user.id
    )
  ) {
    await tempInteractionNotice(
      interaction,
      'Chỉ chủ phòng mới có thể sử dụng chức năng này.',
      'warning'
    );

    return null;
  }

  return context;
}

async function createRoomChannelForOwner(
  guild,
  owner,
  categoryId
) {
  const category =
    await fetchChannelSafe(
      guild,
      categoryId
    );

  if (
    !isCategoryChannel(
      category
    )
  ) {
    return null;
  }

  try {
    return await guild.channels.create({
      name:
        roomNameFromMember(
          owner
        ),

      type:
        ChannelType.GuildVoice,

      parent:
        category.id,

      permissionOverwrites: [
        {
          id:
            owner.id,

          type:
            OverwriteType.Member,

          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.Speak
          ]
        }
      ],

      reason:
        `${BOT_NAME} tạo phòng tạm cho ${owner.user.username}`
    });
  } catch (error) {
    logError(
      'CREATE_TEMP_ROOM',
      error
    );

    return null;
  }
}

async function positionTempRoomBelowGenerator(
  roomChannel,
  generatorChannel
) {
  if (
    !isVoiceChannel(
      roomChannel
    )
  ) {
    return false;
  }

  try {
    if (
      isVoiceChannel(
        generatorChannel
      ) &&
      String(
        generatorChannel.parentId ||
        ''
      ) ===
      String(
        roomChannel.parentId ||
        ''
      )
    ) {
      await generatorChannel.setPosition(
        0,
        {
          reason:
            `${BOT_NAME} giữ kênh tạo phòng ở đầu danh mục`
        }
      );

      const generatorPosition =
        Number(
          generatorChannel.rawPosition ??
          generatorChannel.position ??
          0
        );

      await roomChannel.setPosition(
        generatorPosition +
          1,
        {
          reason:
            `${BOT_NAME} đặt phòng tạm dưới kênh tạo phòng`
        }
      );

      return true;
    }

    return false;
  } catch (error) {
    logError(
      'POSITION_TEMP_ROOM',
      error
    );

    return false;
  }
}

async function removeStaleOwnedRoom(
  guild,
  room
) {
  if (!room) {
    return false;
  }

  const channel =
    await fetchChannelSafe(
      guild,
      room.channel_id
    );

  if (
    isVoiceChannel(
      channel
    )
  ) {
    return false;
  }

  clearRoomRuntimeState(
    room.channel_id
  );

  try {
    await deleteRoomRecord(
      room.channel_id
    );

    return true;
  } catch (error) {
    logError(
      'REMOVE_STALE_OWNED_ROOM',
      error
    );

    return false;
  }
}

async function rollbackCreatedRoom(
  channel
) {
  if (!channel) {
    return;
  }

  const deleted =
    await safeDeleteChannel(
      channel,
      `${BOT_NAME} hoàn tác phòng tạo chưa hoàn chỉnh`
    );

  if (!deleted) {
    return;
  }

  clearRoomRuntimeState(
    channel.id
  );

  try {
    await deleteRoomRecord(
      channel.id
    );
  } catch (error) {
    logError(
      'ROLLBACK_ROOM_RECORD',
      error
    );
  }
}

async function moveOwnerToExistingRoom(
  guild,
  member,
  room
) {
  const channel =
    await fetchChannelSafe(
      guild,
      room.channel_id
    );

  if (
    !isVoiceChannel(
      channel
    )
  ) {
    return {
      ok: false,
      stale: true,
      channel: null
    };
  }

  await grantRoomOwnerPermissions(
    channel,
    member.id
  );

  await refreshRoomPanelSafe(
    channel.id
  );

  const currentVoice =
    getMemberVoiceChannelId(
      guild,
      member.id
    );

  if (
    String(
      currentVoice ||
      ''
    ) ===
    String(
      channel.id
    )
  ) {
    return {
      ok: true,
      stale: false,
      channel
    };
  }

  const moved =
    await safeMoveMember(
      member,
      channel,
      `${BOT_NAME} đưa chủ phòng về phòng hiện có`
    );

  return {
    ok:
      moved,
    stale:
      false,
    channel
  };
}

async function createManagedTempRoom(
  guild,
  member,
  generator
) {
  const generatorChannel =
    await fetchChannelSafe(
      guild,
      generator.create_voice_id
    );

  if (
    !isVoiceChannel(
      generatorChannel
    )
  ) {
    return {
      ok: false,
      reason:
        'GENERATOR_MISSING'
    };
  }

  const categoryId =
    generator.button_category_id;

  const category =
    await fetchChannelSafe(
      guild,
      categoryId
    );

  if (
    !isCategoryChannel(
      category
    )
  ) {
    return {
      ok: false,
      reason:
        'CATEGORY_MISSING'
    };
  }

  const channel =
    await createRoomChannelForOwner(
      guild,
      member,
      category.id
    );

  if (!channel) {
    return {
      ok: false,
      reason:
        'CREATE_FAILED'
    };
  }

  let room = null;

  try {
    room =
      await saveRoom({
        guildId:
          guild.id,

        channelId:
          channel.id,

        ownerId:
          member.id,

        categoryId:
          category.id,

        controlMessageId:
          null
      });
  } catch (error) {
    logError(
      'SAVE_NEW_ROOM',
      error
    );

    await safeDeleteChannel(
      channel,
      `${BOT_NAME} hoàn tác phòng không lưu được dữ liệu`
    );

    return {
      ok: false,
      reason:
        'DATABASE_FAILED'
    };
  }

  if (!room) {
    await safeDeleteChannel(
      channel,
      `${BOT_NAME} hoàn tác phòng không có dữ liệu`
    );

    return {
      ok: false,
      reason:
        'DATABASE_FAILED'
    };
  }

  await positionTempRoomBelowGenerator(
    channel,
    generatorChannel
  );

  const panel =
    await ensureRoomPanel(
      channel.id
    );

  if (!panel) {
    await rollbackCreatedRoom(
      channel
    );

    return {
      ok: false,
      reason:
        'PANEL_FAILED'
    };
  }

  const freshMember =
    await fetchMemberSafe(
      guild,
      member.id
    );

  if (!freshMember) {
    await rollbackCreatedRoom(
      channel
    );

    return {
      ok: false,
      reason:
        'MEMBER_MISSING'
    };
  }

  const moved =
    await safeMoveMember(
      freshMember,
      channel,
      `${BOT_NAME} đưa chủ phòng vào phòng tạm`
    );

  if (!moved) {
    await rollbackCreatedRoom(
      channel
    );

    return {
      ok: false,
      reason:
        'MOVE_FAILED'
    };
  }

  const verifiedMember =
    await resolveMemberInExactRoom(
      guild,
      freshMember.id,
      channel.id
    );

  if (!verifiedMember) {
    await rollbackCreatedRoom(
      channel
    );

    return {
      ok: false,
      reason:
        'MOVE_VERIFY_FAILED'
    };
  }

  await recordMemberPresence(
    guild.id,
    channel.id,
    verifiedMember.id,
    new Date()
  );

  await refreshRoomPanelSafe(
    channel.id
  );

  return {
    ok: true,
    reason: null,
    room,
    channel,
    panel
  };
}

async function handleGeneratorJoin(
  guild,
  member,
  generatorChannelId
) {
  if (
    !guild ||
    !member ||
    member.user?.bot
  ) {
    return;
  }

  return withCreateLock(
    guild.id,
    member.id,
    async () => {
      const generator =
        await getGenerator(
          guild.id
        );

      if (!generator) {
        return;
      }

      if (
        !generator.create_voice_id ||
        String(
          generator.create_voice_id
        ) !==
        String(
          generatorChannelId
        )
      ) {
        return;
      }

      const actualVoiceChannelId =
        getMemberVoiceChannelId(
          guild,
          member.id
        );

      if (
        String(
          actualVoiceChannelId ||
          ''
        ) !==
        String(
          generator.create_voice_id
        )
      ) {
        return;
      }

      let ownedRoom =
        await getOwnedRoom(
          guild.id,
          member.id
        );

      if (ownedRoom) {
        const existingChannel =
          await fetchChannelSafe(
            guild,
            ownedRoom.channel_id
          );

        if (
          !isVoiceChannel(
            existingChannel
          )
        ) {
          const removed =
            await removeStaleOwnedRoom(
              guild,
              ownedRoom
            );

          if (!removed) {
            return;
          }

          ownedRoom =
            null;
        }
      }

      if (ownedRoom) {
        const freshMember =
          await fetchMemberSafe(
            guild,
            member.id
          );

        if (!freshMember) {
          return;
        }

        const stillAtGenerator =
          getMemberVoiceChannelId(
            guild,
            freshMember.id
          );

        if (
          String(
            stillAtGenerator ||
            ''
          ) !==
          String(
            generator.create_voice_id
          )
        ) {
          return;
        }

        const result =
          await moveOwnerToExistingRoom(
            guild,
            freshMember,
            ownedRoom
          );

        if (
          result.ok &&
          result.channel
        ) {
          await recordMemberPresence(
            guild.id,
            result.channel.id,
            freshMember.id,
            new Date()
          );

          await refreshRoomPanelSafe(
            result.channel.id
          );
        }

        return;
      }

      const freshMember =
        await fetchMemberSafe(
          guild,
          member.id
        );

      if (!freshMember) {
        return;
      }

      const stillAtGenerator =
        getMemberVoiceChannelId(
          guild,
          freshMember.id
        );

      if (
        String(
          stillAtGenerator ||
          ''
        ) !==
        String(
          generator.create_voice_id
        )
      ) {
        return;
      }

      await createManagedTempRoom(
        guild,
        freshMember,
        generator
      );
    }
  );
}

async function handleRoomMemberSelect(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  const memberId =
    interaction.values?.[0];

  if (
    !isSnowflake(
      memberId
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Thành viên được chọn không hợp lệ.',
      'warning'
    );
  }

  const member =
    await fetchMemberSafe(
      interaction.guild,
      memberId
    );

  if (
    !member ||
    member.user?.bot
  ) {
    clearSelectedMember(
      interaction.guildId,
      context.channel.id,
      context.room.owner_id
    );

    await acknowledgeComponent(
      interaction
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    return tempFollowUp(
      interaction,
      'Không thể chọn thành viên này.',
      'warning'
    );
  }

  if (
    String(
      member.id
    ) ===
    String(
      interaction.user.id
    )
  ) {
    clearSelectedMember(
      interaction.guildId,
      context.channel.id,
      context.room.owner_id
    );

    await acknowledgeComponent(
      interaction
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    return tempFollowUp(
      interaction,
      'Bạn không cần chọn chính mình.',
      'warning'
    );
  }

  setSelectedMember(
    interaction.guildId,
    context.channel.id,
    context.room.owner_id,
    member.id
  );

  await interaction.update({
    content:
      await buildRoomPanelContent(
        context.channel,
        context.room,
        await getGenerator(
          interaction.guildId
        )
      ),

    components:
      await buildRoomPanelComponents(
        context.channel,
        context.room
      ),

    allowedMentions: {
      parse: []
    }
  });
}

async function getFreshSelectedRoomMember(
  interaction,
  context
) {
  const memberId =
    getSelectedMemberId(
      interaction.guildId,
      context.channel.id,
      context.room.owner_id
    );

  if (!memberId) {
    await tempInteractionNotice(
      interaction,
      'Hãy chọn một thành viên trước.',
      'warning'
    );

    return null;
  }

  const member =
    await fetchMemberSafe(
      interaction.guild,
      memberId
    );

  if (
    !member ||
    member.user?.bot
  ) {
    await acknowledgeComponent(
      interaction
    );

    await resetSelectedMemberAndPanel(
      interaction.guildId,
      context.channel.id,
      context.room.owner_id
    );

    await tempFollowUp(
      interaction,
      'Người đã chọn không còn hợp lệ.',
      'warning'
    );

    return null;
  }

  if (
    String(
      member.id
    ) ===
    String(
      interaction.user.id
    )
  ) {
    await acknowledgeComponent(
      interaction
    );

    await resetSelectedMemberAndPanel(
      interaction.guildId,
      context.channel.id,
      context.room.owner_id
    );

    await tempFollowUp(
      interaction,
      'Bạn không thể thực hiện thao tác này với chính mình.',
      'warning'
    );

    return null;
  }

  return member;
}

async function requireSelectedMemberInExactRoom(
  interaction,
  context
) {
  const member =
    await getFreshSelectedRoomMember(
      interaction,
      context
    );

  if (!member) {
    return null;
  }

  const freshMember =
    await resolveMemberInExactRoom(
      interaction.guild,
      member.id,
      context.channel.id
    );

  if (!freshMember) {
    await acknowledgeComponent(
      interaction
    );

    await resetSelectedMemberAndPanel(
      interaction.guildId,
      context.channel.id,
      context.room.owner_id
    );

    await tempFollowUp(
      interaction,
      `${safeMemberName(member)} không có mặt trong phòng này.`,
      'warning'
    );

    return null;
  }

  return freshMember;
}

async function finishSelectedMemberAction(
  interaction,
  context
) {
  clearSelectedMember(
    interaction.guildId,
    context.channel.id,
    context.room.owner_id
  );

  await refreshRoomPanelSafe(
    context.channel.id
  );
}
async function handleRoomLock(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    useCooldown(
      interaction,
      'room_lock'
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn thao tác quá nhanh.',
      'warning'
    );
  }

  await acknowledgeComponent(
    interaction
  );

  const currentlyLocked =
    roomIsLocked(
      context.channel
    );

  const changed =
    await safePermissionEdit(
      context.channel,
      interaction.guild.id,
      {
        Connect:
          currentlyLocked
            ? null
            : false
      },
      currentlyLocked
        ? `${BOT_NAME} mở phòng`
        : `${BOT_NAME} khóa phòng`
    );

  if (!changed) {
    return tempFollowUp(
      interaction,
      'Không thể thay đổi trạng thái khóa phòng.',
      'error'
    );
  }

  await grantRoomOwnerPermissions(
    context.channel,
    context.room.owner_id
  );

  await refreshRoomPanelSafe(
    context.channel.id
  );

  return tempFollowUp(
    interaction,
    currentlyLocked
      ? 'Đã mở phòng.'
      : 'Đã khóa phòng.',
    'success'
  );
}

async function handleRoomHide(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    useCooldown(
      interaction,
      'room_hide'
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn thao tác quá nhanh.',
      'warning'
    );
  }

  await acknowledgeComponent(
    interaction
  );

  const currentlyHidden =
    roomIsHidden(
      context.channel
    );

  const changed =
    await safePermissionEdit(
      context.channel,
      interaction.guild.id,
      {
        ViewChannel:
          currentlyHidden
            ? null
            : false
      },
      currentlyHidden
        ? `${BOT_NAME} hiện phòng`
        : `${BOT_NAME} ẩn phòng`
    );

  if (!changed) {
    return tempFollowUp(
      interaction,
      'Không thể thay đổi trạng thái hiển thị.',
      'error'
    );
  }

  await grantRoomOwnerPermissions(
    context.channel,
    context.room.owner_id
  );

  await refreshRoomPanelSafe(
    context.channel.id
  );

  return tempFollowUp(
    interaction,
    currentlyHidden
      ? 'Đã chuyển phòng sang Công khai.'
      : 'Đã ẩn phòng.',
    'success'
  );
}

async function handleRoomRenameButton(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    useCooldown(
      interaction,
      'room_rename'
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn thao tác quá nhanh.',
      'warning'
    );
  }

  const currentName =
    cleanRoomName(
      context.channel.name
    );

  const input =
    new TextInputBuilder()
      .setCustomId(
        'room_rename_value'
      )
      .setLabel(
        'Tên phòng mới'
      )
      .setStyle(
        TextInputStyle.Short
      )
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(80)
      .setPlaceholder(
        'Nhập tên phòng'
      );

  if (currentName) {
    input.setValue(
      currentName.slice(
        0,
        80
      )
    );
  }

  const modal =
    new ModalBuilder()
      .setCustomId(
        'room_rename_modal'
      )
      .setTitle(
        'Đổi tên phòng'
      )
      .addComponents(
        new ActionRowBuilder()
          .addComponents(
            input
          )
      );

  await interaction.showModal(
    modal
  );
}

async function handleRoomRenameModal(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  const value =
    cleanRoomName(
      interaction.fields.getTextInputValue(
        'room_rename_value'
      )
    );

  if (!value) {
    return tempReply(
      interaction,
      'Tên phòng không hợp lệ.',
      'warning'
    );
  }

  await interaction.deferReply({
    ephemeral: true
  });

  const edited =
    await safeEditChannel(
      context.channel,
      {
        name:
          `${ROOM_PREFIX}${value}`.slice(
            0,
            100
          )
      },
      `${BOT_NAME} đổi tên phòng`
    );

  if (!edited) {
    await interaction.editReply({
      content:
        buildNoticeText(
          'Không thể đổi tên phòng.',
          'error'
        )
    });

    scheduleOriginalReplyDelete(
      interaction
    );

    return;
  }

  await refreshRoomPanelSafe(
    context.channel.id
  );

  await interaction.editReply({
    content:
      buildNoticeText(
        `Đã đổi tên phòng thành ${value}.`,
        'success'
      )
  });

  scheduleOriginalReplyDelete(
    interaction
  );
}

async function handleRoomLimitButton(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    useCooldown(
      interaction,
      'room_limit'
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn thao tác quá nhanh.',
      'warning'
    );
  }

  const input =
    new TextInputBuilder()
      .setCustomId(
        'room_limit_value'
      )
      .setLabel(
        'Giới hạn thành viên (0 = không giới hạn)'
      )
      .setStyle(
        TextInputStyle.Short
      )
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(2)
      .setPlaceholder(
        '0 - 99'
      )
      .setValue(
        String(
          context.channel.userLimit ||
          0
        )
      );

  const modal =
    new ModalBuilder()
      .setCustomId(
        'room_limit_modal'
      )
      .setTitle(
        'Giới hạn thành viên'
      )
      .addComponents(
        new ActionRowBuilder()
          .addComponents(
            input
          )
      );

  await interaction.showModal(
    modal
  );
}

async function handleRoomLimitModal(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  const raw =
    interaction.fields
      .getTextInputValue(
        'room_limit_value'
      )
      .trim();

  if (
    !/^\d{1,2}$/.test(
      raw
    )
  ) {
    return tempReply(
      interaction,
      'Giới hạn phải là số từ 0 đến 99.',
      'warning'
    );
  }

  const limit =
    Number(raw);

  if (
    !Number.isInteger(
      limit
    ) ||
    limit < 0 ||
    limit > 99
  ) {
    return tempReply(
      interaction,
      'Giới hạn phải nằm trong khoảng 0 đến 99.',
      'warning'
    );
  }

  await interaction.deferReply({
    ephemeral: true
  });

  const edited =
    await safeEditChannel(
      context.channel,
      {
        userLimit:
          limit
      },
      `${BOT_NAME} thay đổi giới hạn phòng`
    );

  if (!edited) {
    await interaction.editReply({
      content:
        buildNoticeText(
          'Không thể thay đổi giới hạn phòng.',
          'error'
        )
    });

    scheduleOriginalReplyDelete(
      interaction
    );

    return;
  }

  await refreshRoomPanelSafe(
    context.channel.id
  );

  await interaction.editReply({
    content:
      buildNoticeText(
        limit === 0
          ? 'Đã bỏ giới hạn thành viên.'
          : `Đã đặt giới hạn ${limit} thành viên.`,
        'success'
      )
  });

  scheduleOriginalReplyDelete(
    interaction
  );
}

async function handleRoomInvite(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    useCooldown(
      interaction,
      'room_invite'
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn thao tác quá nhanh.',
      'warning'
    );
  }

  const member =
    await getFreshSelectedRoomMember(
      interaction,
      context
    );

  if (!member) {
    return;
  }

  await acknowledgeComponent(
    interaction
  );

  const freshMember =
    await fetchMemberSafe(
      interaction.guild,
      member.id
    );

  if (
    !freshMember ||
    freshMember.user?.bot
  ) {
    await finishSelectedMemberAction(
      interaction,
      context
    );

    return tempFollowUp(
      interaction,
      'Người đã chọn không còn hợp lệ.',
      'warning'
    );
  }

  const banned =
    await isRoomBanned(
      context.channel.id,
      freshMember.id
    );

  if (banned) {
    await finishSelectedMemberAction(
      interaction,
      context
    );

    return tempFollowUp(
      interaction,
      `${safeMemberName(freshMember)} đang bị cấm khỏi phòng.`,
      'warning'
    );
  }

  const granted =
    await grantInvitedMemberPermissions(
      context.channel,
      freshMember.id
    );

  if (!granted) {
    return tempFollowUp(
      interaction,
      `Không thể cấp quyền vào phòng cho ${safeMemberName(freshMember)}.`,
      'error'
    );
  }

  await finishSelectedMemberAction(
    interaction,
    context
  );

  return tempFollowUp(
    interaction,
    `Đã cấp quyền vào phòng cho ${safeMemberName(freshMember)}.`,
    'success'
  );
}

async function handleRoomDeny(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    useCooldown(
      interaction,
      'room_deny'
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn thao tác quá nhanh.',
      'warning'
    );
  }

  const selected =
    await getFreshSelectedRoomMember(
      interaction,
      context
    );

  if (!selected) {
    return;
  }

  const alreadyBanned =
    await isRoomBanned(
      context.channel.id,
      selected.id
    );

  if (alreadyBanned) {
    await acknowledgeComponent(
      interaction
    );

    const stillBanned =
      await isRoomBanned(
        context.channel.id,
        selected.id
      );

    if (!stillBanned) {
      await finishSelectedMemberAction(
        interaction,
        context
      );

      return tempFollowUp(
        interaction,
        `${safeMemberName(selected)} không còn trong danh sách cấm.`,
        'warning'
      );
    }

    const removed =
      await removeMemberRoomOverride(
        context.channel,
        selected.id
      );

    if (!removed) {
      return tempFollowUp(
        interaction,
        `Không thể bỏ cấm ${safeMemberName(selected)}.`,
        'error'
      );
    }

    try {
      await removeRoomBan(
        context.channel.id,
        selected.id
      );
    } catch (error) {
      logError(
        'ROOM_UNBAN_DATABASE',
        error
      );

      await denyMemberPermissions(
        context.channel,
        selected.id
      );

      return tempFollowUp(
        interaction,
        'Không thể cập nhật dữ liệu bỏ cấm. Quyền cấm đã được khôi phục.',
        'error'
      );
    }

    await finishSelectedMemberAction(
      interaction,
      context
    );

    return tempFollowUp(
      interaction,
      `Đã bỏ cấm ${safeMemberName(selected)}.`,
      'success'
    );
  }

  await acknowledgeComponent(
    interaction
  );

  const freshSelected =
    await fetchMemberSafe(
      interaction.guild,
      selected.id
    );

  if (
    !freshSelected ||
    freshSelected.user?.bot
  ) {
    await finishSelectedMemberAction(
      interaction,
      context
    );

    return tempFollowUp(
      interaction,
      'Người đã chọn không còn hợp lệ.',
      'warning'
    );
  }

  const denied =
    await denyMemberPermissions(
      context.channel,
      freshSelected.id
    );

  if (!denied) {
    return tempFollowUp(
      interaction,
      `Không thể cấm ${safeMemberName(freshSelected)} khỏi phòng.`,
      'error'
    );
  }

  try {
    await addRoomBan(
      interaction.guildId,
      context.channel.id,
      freshSelected.id,
      interaction.user.id
    );
  } catch (error) {
    logError(
      'ROOM_BAN_DATABASE',
      error
    );

    await removeMemberRoomOverride(
      context.channel,
      freshSelected.id
    );

    return tempFollowUp(
      interaction,
      'Không thể lưu dữ liệu cấm. Quyền phòng đã được hoàn tác.',
      'error'
    );
  }

  const voiceMember =
    await resolveMemberInExactRoom(
      interaction.guild,
      freshSelected.id,
      context.channel.id
    );

  if (voiceMember) {
    try {
      await voiceMember.voice.disconnect(
        `${BOT_NAME} cấm thành viên khỏi phòng`
      );
    } catch (error) {
      logError(
        'ROOM_DENY_DISCONNECT',
        error
      );
    }
  }

  await finishSelectedMemberAction(
    interaction,
    context
  );

  return tempFollowUp(
    interaction,
    `Đã cấm ${safeMemberName(freshSelected)} khỏi phòng.`,
    'success'
  );
}
async function handleRoomKick(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    useCooldown(
      interaction,
      'room_kick'
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn thao tác quá nhanh.',
      'warning'
    );
  }

  const member =
    await requireSelectedMemberInExactRoom(
      interaction,
      context
    );

  if (!member) {
    return;
  }

  await acknowledgeComponent(
    interaction
  );

  const result =
    await safeDisconnectMember(
      interaction.guild,
      member.id,
      context.channel.id,
      `${BOT_NAME} đuổi thành viên khỏi phòng`
    );

  if (!result.ok) {
    await finishSelectedMemberAction(
      interaction,
      context
    );

    return tempFollowUp(
      interaction,
      result.reason ===
        'NOT_IN_ROOM'
        ? `${safeMemberName(member)} không còn trong phòng.`
        : `Không thể đuổi ${safeMemberName(member)} khỏi phòng.`,
      result.reason ===
        'NOT_IN_ROOM'
        ? 'warning'
        : 'error'
    );
  }

  await finishSelectedMemberAction(
    interaction,
    context
  );

  return tempFollowUp(
    interaction,
    `Đã đuổi ${safeMemberName(member)} khỏi phòng.`,
    'success'
  );
}

async function handleRoomTransfer(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    useCooldown(
      interaction,
      'room_transfer'
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn thao tác quá nhanh.',
      'warning'
    );
  }

  const member =
    await requireSelectedMemberInExactRoom(
      interaction,
      context
    );

  if (!member) {
    return;
  }

  const ownedRoom =
    await getOwnedRoom(
      interaction.guildId,
      member.id
    );

  if (
    ownedRoom &&
    String(
      ownedRoom.channel_id
    ) !==
    String(
      context.channel.id
    )
  ) {
    await acknowledgeComponent(
      interaction
    );

    await finishSelectedMemberAction(
      interaction,
      context
    );

    return tempFollowUp(
      interaction,
      `${safeMemberName(member)} đang sở hữu một phòng khác.`,
      'warning'
    );
  }

  await acknowledgeComponent(
    interaction
  );

  clearPendingTransfer(
    context.channel.id
  );

  const transfer = {
    guildId:
      String(
        interaction.guildId
      ),

    channelId:
      String(
        context.channel.id
      ),

    oldOwnerId:
      String(
        context.room.owner_id
      ),

    newOwnerId:
      String(
        member.id
      ),

    createdAt:
      Date.now(),

    expiresAt:
      Date.now() +
      TRANSFER_TIMEOUT_MS,

    timer:
      null
  };

  const timer =
    setTimeout(
      () => {
        const current =
          getPendingTransfer(
            context.channel.id
          );

        if (
          current &&
          current ===
            transfer
        ) {
          pendingTransfers.delete(
            transferKey(
              context.channel.id
            )
          );
        }
      },
      TRANSFER_TIMEOUT_MS
    );

  timer.unref?.();

  transfer.timer =
    timer;

  setPendingTransfer(
    context.channel.id,
    transfer
  );

  clearSelectedMember(
    interaction.guildId,
    context.channel.id,
    context.room.owner_id
  );

  await refreshRoomPanelSafe(
    context.channel.id
  );

  try {
    await context.channel.send({
      content:
        [
          `👑 <@${member.id}>`,
          `<@${interaction.user.id}> muốn chuyển quyền chủ phòng cho bạn.`,
          '',
          `Yêu cầu sẽ hết hạn sau ${Math.floor(
            TRANSFER_TIMEOUT_MS /
              1000
          )} giây.`
        ].join('\n'),

      components: [
        new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(
                `transfer_accept:${context.channel.id}`
              )
              .setLabel(
                'Nhận quyền chủ phòng'
              )
              .setEmoji(
                '👑'
              )
              .setStyle(
                ButtonStyle.Success
              ),

            new ButtonBuilder()
              .setCustomId(
                `transfer_decline:${context.channel.id}`
              )
              .setLabel(
                'Từ chối'
              )
              .setEmoji(
                '✖️'
              )
              .setStyle(
                ButtonStyle.Danger
              )
          )
      ],

      allowedMentions: {
        users: [
          member.id,
          interaction.user.id
        ]
      }
    });
  } catch (error) {
    clearPendingTransfer(
      context.channel.id
    );

    logError(
      'SEND_TRANSFER_REQUEST',
      error
    );

    return tempFollowUp(
      interaction,
      'Không thể gửi yêu cầu chuyển chủ phòng.',
      'error'
    );
  }

  return tempFollowUp(
    interaction,
    `Đã gửi yêu cầu chuyển chủ cho ${safeMemberName(member)}.`,
    'success'
  );
}

async function handleTransferDecline(
  interaction,
  channelId
) {
  const transfer =
    getPendingTransfer(
      channelId
    );

  if (!transfer) {
    await acknowledgeComponent(
      interaction
    );

    return tempFollowUp(
      interaction,
      'Yêu cầu chuyển chủ đã hết hạn hoặc không còn tồn tại.',
      'warning'
    );
  }

  if (
    String(
      transfer.guildId
    ) !==
    String(
      interaction.guildId
    )
  ) {
    await acknowledgeComponent(
      interaction
    );

    return tempFollowUp(
      interaction,
      'Yêu cầu chuyển chủ không hợp lệ.',
      'warning'
    );
  }

  if (
    String(
      interaction.user.id
    ) !==
    String(
      transfer.newOwnerId
    )
  ) {
    await acknowledgeComponent(
      interaction
    );

    return tempFollowUp(
      interaction,
      'Chỉ người được chuyển chủ mới có thể từ chối yêu cầu này.',
      'warning'
    );
  }

  clearPendingTransfer(
    channelId
  );

  try {
    await interaction.update({
      content:
        `❌ <@${interaction.user.id}> đã từ chối nhận quyền chủ phòng.`,

      components: [],

      allowedMentions: {
        users: [
          interaction.user.id
        ]
      }
    });
  } catch (error) {
    logError(
      'TRANSFER_DECLINE_UPDATE',
      error
    );

    await acknowledgeComponent(
      interaction
    );
  }

  return tempFollowUp(
    interaction,
    'Đã từ chối yêu cầu chuyển chủ.',
    'info'
  );
}

async function transferRoomOwnership(
  guild,
  channelId,
  oldOwnerId,
  newOwnerId
) {
  const channel =
    await fetchChannelSafe(
      guild,
      channelId
    );

  if (
    !isVoiceChannel(
      channel
    )
  ) {
    return {
      ok: false,
      reason:
        'ROOM_MISSING'
    };
  }

  const newOwner =
    await resolveMemberInExactRoom(
      guild,
      newOwnerId,
      channel.id
    );

  if (!newOwner) {
    return {
      ok: false,
      reason:
        'TARGET_NOT_IN_ROOM'
    };
  }

  if (
    newOwner.user?.bot
  ) {
    return {
      ok: false,
      reason:
        'INVALID_TARGET'
    };
  }

  const db =
    await pool.connect();

  let updatedRoom =
    null;

  try {
    await db.query(
      'BEGIN'
    );

    const roomResult =
      await db.query(
        `
          SELECT *
          FROM rooms
          WHERE channel_id = $1
          FOR UPDATE
        `,
        [
          String(
            channel.id
          )
        ]
      );

    const room =
      roomResult.rows[0];

    if (!room) {
      await db.query(
        'ROLLBACK'
      );

      return {
        ok: false,
        reason:
          'ROOM_MISSING'
      };
    }

    if (
      String(
        room.owner_id
      ) !==
      String(
        oldOwnerId
      )
    ) {
      await db.query(
        'ROLLBACK'
      );

      return {
        ok: false,
        reason:
          'OWNER_CHANGED'
      };
    }

    const targetRoomResult =
      await db.query(
        `
          SELECT *
          FROM rooms
          WHERE guild_id = $1
            AND owner_id = $2
            AND channel_id <> $3
          FOR UPDATE
        `,
        [
          String(
            guild.id
          ),
          String(
            newOwner.id
          ),
          String(
            channel.id
          )
        ]
      );

    if (
      targetRoomResult.rows.length >
      0
    ) {
      await db.query(
        'ROLLBACK'
      );

      return {
        ok: false,
        reason:
          'TARGET_HAS_ROOM'
      };
    }

    const stillInRoom =
      await resolveMemberInExactRoom(
        guild,
        newOwner.id,
        channel.id
      );

    if (!stillInRoom) {
      await db.query(
        'ROLLBACK'
      );

      return {
        ok: false,
        reason:
          'TARGET_NOT_IN_ROOM'
      };
    }

    const updateResult =
      await db.query(
        `
          UPDATE rooms
          SET owner_id = $1,
              updated_at = NOW()
          WHERE channel_id = $2
          RETURNING *
        `,
        [
          String(
            newOwner.id
          ),
          String(
            channel.id
          )
        ]
      );

    updatedRoom =
      updateResult.rows[0];

    await db.query(
      'COMMIT'
    );
  } catch (error) {
    await db.query(
      'ROLLBACK'
    ).catch(
      () => {}
    );

    if (
      String(
        error?.code ||
        ''
      ) ===
      '23505'
    ) {
      return {
        ok: false,
        reason:
          'TARGET_HAS_ROOM'
      };
    }

    logError(
      'TRANSFER_ROOM_OWNERSHIP_DB',
      error
    );

    return {
      ok: false,
      reason:
        'DATABASE_FAILED'
    };
  } finally {
    db.release();
  }

  if (!updatedRoom) {
    return {
      ok: false,
      reason:
        'DATABASE_FAILED'
    };
  }

  await revokeRoomOwnerPermissions(
    channel,
    oldOwnerId
  );

  const granted =
    await grantRoomOwnerPermissions(
      channel,
      newOwner.id
    );

  if (!granted) {
    logError(
      'TRANSFER_OWNER_PERMISSION',
      new Error(
        `Không thể cấp quyền chủ phòng mới ${newOwner.id} cho ${channel.id}`
      )
    );
  }

  clearOwnerAbsenceTimer(
    channel.id
  );

  try {
    await clearOwnerAbsence(
      channel.id
    );
  } catch (error) {
    logError(
      'TRANSFER_CLEAR_OWNER_ABSENCE',
      error
    );
  }

  clearSelectedMember(
    guild.id,
    channel.id,
    oldOwnerId
  );

  clearSelectedMember(
    guild.id,
    channel.id,
    newOwner.id
  );

  await refreshRoomPanelSafe(
    channel.id
  );

  return {
    ok: true,
    reason: null,
    room:
      updatedRoom,
    channel,
    newOwner
  };
}

async function handleTransferAccept(
  interaction,
  channelId
) {
  const transfer =
    getPendingTransfer(
      channelId
    );

  if (!transfer) {
    await acknowledgeComponent(
      interaction
    );

    return tempFollowUp(
      interaction,
      'Yêu cầu chuyển chủ đã hết hạn hoặc không còn tồn tại.',
      'warning'
    );
  }

  if (
    String(
      transfer.guildId
    ) !==
    String(
      interaction.guildId
    )
  ) {
    await acknowledgeComponent(
      interaction
    );

    return tempFollowUp(
      interaction,
      'Yêu cầu chuyển chủ không hợp lệ.',
      'warning'
    );
  }

  if (
    String(
      interaction.user.id
    ) !==
    String(
      transfer.newOwnerId
    )
  ) {
    await acknowledgeComponent(
      interaction
    );

    return tempFollowUp(
      interaction,
      'Chỉ người được chuyển chủ mới có thể nhận quyền chủ phòng.',
      'warning'
    );
  }

  await acknowledgeComponent(
    interaction
  );

  const room =
    await getRoom(
      channelId
    );

  if (!room) {
    clearPendingTransfer(
      channelId
    );

    return tempFollowUp(
      interaction,
      'Phòng này không còn được Voice HDK quản lý.',
      'warning'
    );
  }

  if (
    String(
      room.owner_id
    ) !==
    String(
      transfer.oldOwnerId
    )
  ) {
    clearPendingTransfer(
      channelId
    );

    return tempFollowUp(
      interaction,
      'Chủ phòng đã thay đổi. Yêu cầu chuyển chủ cũ đã bị hủy.',
      'warning'
    );
  }

  const result =
    await transferRoomOwnership(
      interaction.guild,
      channelId,
      transfer.oldOwnerId,
      transfer.newOwnerId
    );

  if (!result.ok) {
    if (
      result.reason ===
      'TARGET_NOT_IN_ROOM'
    ) {
      clearPendingTransfer(
        channelId
      );

      return tempFollowUp(
        interaction,
        'Bạn phải có mặt trong phòng để nhận quyền chủ phòng.',
        'warning'
      );
    }

    if (
      result.reason ===
      'TARGET_HAS_ROOM'
    ) {
      clearPendingTransfer(
        channelId
      );

      return tempFollowUp(
        interaction,
        'Bạn đang sở hữu một phòng khác nên không thể nhận thêm phòng.',
        'warning'
      );
    }

    if (
      result.reason ===
      'OWNER_CHANGED' ||
      result.reason ===
      'ROOM_MISSING'
    ) {
      clearPendingTransfer(
        channelId
      );

      return tempFollowUp(
        interaction,
        'Yêu cầu chuyển chủ không còn hợp lệ.',
        'warning'
      );
    }

    return tempFollowUp(
      interaction,
      'Không thể chuyển quyền chủ phòng lúc này.',
      'error'
    );
  }

  clearPendingTransfer(
    channelId
  );

  try {
    await interaction.message.edit({
      content:
        [
          '✅ **Chuyển chủ phòng thành công.**',
          '',
          `👑 Chủ phòng mới: <@${transfer.newOwnerId}>`,
          `↪️ Chủ phòng cũ: <@${transfer.oldOwnerId}>`
        ].join('\n'),

      components: [],

      allowedMentions: {
        users: [
          transfer.newOwnerId,
          transfer.oldOwnerId
        ]
      }
    });
  } catch (error) {
    if (
      !isUnknownDiscordResource(
        error
      )
    ) {
      logError(
        'TRANSFER_ACCEPT_MESSAGE',
        error
      );
    }
  }

  return tempFollowUp(
    interaction,
    'Bạn đã trở thành chủ phòng.',
    'success'
  );
}
async function handleRoomReset(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    useCooldown(
      interaction,
      'room_reset'
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn thao tác quá nhanh.',
      'warning'
    );
  }

  await acknowledgeComponent(
    interaction
  );

  const channel =
    context.channel;

  const room =
    context.room;

  const edited =
    await safeEditChannel(
      channel,
      {
        userLimit: 0
      },
      `${BOT_NAME} đặt lại phòng`
    );

  if (!edited) {
    return tempFollowUp(
      interaction,
      'Không thể đặt lại giới hạn phòng.',
      'error'
    );
  }

  const everyoneReset =
    await safePermissionEdit(
      channel,
      interaction.guild.id,
      {
        ViewChannel: null,
        Connect: null
      },
      `${BOT_NAME} đặt lại quyền mặc định của phòng`
    );

  if (!everyoneReset) {
    return tempFollowUp(
      interaction,
      'Không thể đặt lại quyền hiển thị và kết nối.',
      'error'
    );
  }

  const memberOverwritesCleared =
    await clearMemberSpecificOverwrites(
      channel,
      [
        room.owner_id
      ]
    );

  if (!memberOverwritesCleared) {
    return tempFollowUp(
      interaction,
      'Không thể xóa hết quyền riêng của thành viên.',
      'error'
    );
  }

  const ownerPermission =
    await grantRoomOwnerPermissions(
      channel,
      room.owner_id
    );

  if (!ownerPermission) {
    return tempFollowUp(
      interaction,
      'Không thể khôi phục quyền chủ phòng.',
      'error'
    );
  }

  const regionResult =
    await setVoiceRegionSafe(
      channel,
      'automatic'
    );

  if (!regionResult.ok) {
    return tempFollowUp(
      interaction,
      'Đã đặt lại phần lớn cấu hình nhưng không thể đưa khu vực thoại về Tự động.',
      'warning'
    );
  }

  try {
    await clearRoomBans(
      channel.id
    );
  } catch (error) {
    logError(
      'RESET_ROOM_BANS',
      error
    );

    return tempFollowUp(
      interaction,
      'Quyền phòng đã được đặt lại nhưng không thể đồng bộ dữ liệu cấm. Hãy thử Đặt lại lần nữa.',
      'error'
    );
  }

  clearPendingTransfer(
    channel.id
  );

  await finishSelectedMemberAction(
    interaction,
    context
  );

  return tempFollowUp(
    interaction,
    'Đã đặt lại phòng: Mở • Công khai • Không giới hạn • Khu vực Tự động • Xóa quyền Mời/Cấm.',
    'success'
  );
}

async function handleRoomRegion(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    useCooldown(
      interaction,
      'room_region'
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn thao tác quá nhanh.',
      'warning'
    );
  }

  const regionId =
    interaction.values?.[0];

  if (!regionId) {
    return tempInteractionNotice(
      interaction,
      'Khu vực thoại không hợp lệ.',
      'warning'
    );
  }

  await acknowledgeComponent(
    interaction
  );

  const result =
    await setVoiceRegionSafe(
      context.channel,
      regionId
    );

  if (!result.ok) {
    return tempFollowUp(
      interaction,
      'Không thể thay đổi khu vực thoại hoặc khu vực này không còn khả dụng.',
      'error'
    );
  }

  await refreshRoomPanelSafe(
    context.channel.id
  );

  return tempFollowUp(
    interaction,
    `Đã chuyển khu vực thoại sang ${result.label}.`,
    'success'
  );
}

function transferRequestComponents(
  channelId,
  disabled = false
) {
  return [
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `transfer_accept:${channelId}`
          )
          .setLabel(
            'Đồng ý'
          )
          .setEmoji(
            '✅'
          )
          .setStyle(
            ButtonStyle.Success
          )
          .setDisabled(
            disabled
          ),

        new ButtonBuilder()
          .setCustomId(
            `transfer_decline:${channelId}`
          )
          .setLabel(
            'Từ chối'
          )
          .setEmoji(
            '✖️'
          )
          .setStyle(
            ButtonStyle.Danger
          )
          .setDisabled(
            disabled
          )
      )
  ];
}

async function expireTransferRequest(
  channelId
) {
  const transfer =
    pendingTransfers.get(
      transferKey(
        channelId
      )
    );

  if (!transfer) {
    return;
  }

  if (
    transfer.expiresAt >
    Date.now()
  ) {
    return;
  }

  pendingTransfers.delete(
    transferKey(
      channelId
    )
  );

  const guild =
    client.guilds.cache.get(
      String(
        transfer.guildId
      )
    );

  if (!guild) {
    return;
  }

  const channel =
    await fetchChannelSafe(
      guild,
      channelId
    );

  if (
    !isVoiceChannel(
      channel
    )
  ) {
    return;
  }

  const message =
    await fetchMessageSafe(
      channel,
      transfer.messageId
    );

  if (!message) {
    return;
  }

  try {
    await message.edit({
      content:
        `⌛ Yêu cầu chuyển chủ cho <@${transfer.targetId}> đã hết hạn.`,

      components:
        transferRequestComponents(
          channelId,
          true
        ),

      allowedMentions: {
        parse: []
      }
    });

    scheduleMessageDelete(
      message
    );
  } catch (error) {
    logError(
      'EXPIRE_TRANSFER_MESSAGE',
      error
    );
  }
}

async function createTransferRequest(
  interaction,
  context,
  target
) {
  const channel =
    context.channel;

  const room =
    context.room;

  const current =
    getPendingTransfer(
      channel.id
    );

  if (current) {
    await tempFollowUp(
      interaction,
      'Phòng đang có một yêu cầu chuyển chủ chờ xử lý.',
      'warning'
    );

    return false;
  }

  const exactTarget =
    await resolveMemberInExactRoom(
      interaction.guild,
      target.id,
      channel.id
    );

  if (!exactTarget) {
    await tempFollowUp(
      interaction,
      `${safeMemberName(target)} không có mặt trong phòng này.`,
      'warning'
    );

    return false;
  }

  const owned =
    await getOwnedRoom(
      interaction.guildId,
      exactTarget.id
    );

  if (
    owned &&
    String(
      owned.channel_id
    ) !==
    String(
      channel.id
    )
  ) {
    await tempFollowUp(
      interaction,
      `${safeMemberName(exactTarget)} đang sở hữu một phòng khác.`,
      'warning'
    );

    return false;
  }

  const expiresAt =
    Date.now() +
    TRANSFER_TIMEOUT_MS;

  let message;

  try {
    message =
      await channel.send({
        content: [
          `👑 <@${exactTarget.id}>, <@${room.owner_id}> muốn chuyển quyền chủ phòng cho bạn.`,
          `Yêu cầu hết hạn ${relativeTimestamp(
            expiresAt
          )}.`
        ].join('\n'),

        components:
          transferRequestComponents(
            channel.id
          ),

        allowedMentions: {
          users: [
            exactTarget.id,
            room.owner_id
          ]
        }
      });
  } catch (error) {
    logError(
      'CREATE_TRANSFER_MESSAGE',
      error
    );

    await tempFollowUp(
      interaction,
      'Không thể tạo yêu cầu chuyển chủ.',
      'error'
    );

    return false;
  }

  const transfer = {
    guildId:
      String(
        interaction.guildId
      ),

    channelId:
      String(
        channel.id
      ),

    ownerId:
      String(
        room.owner_id
      ),

    targetId:
      String(
        exactTarget.id
      ),

    messageId:
      String(
        message.id
      ),

    createdAt:
      Date.now(),

    expiresAt,

    timer:
      null
  };

  const timer =
    setTimeout(
      () => {
        expireTransferRequest(
          channel.id
        ).catch(
          error => {
            logError(
              'TRANSFER_EXPIRE_TIMER',
              error
            );
          }
        );
      },
      TRANSFER_TIMEOUT_MS +
        250
    );

  timer.unref?.();

  transfer.timer =
    timer;

  setPendingTransfer(
    channel.id,
    transfer
  );

  await tempFollowUp(
    interaction,
    `Đã gửi yêu cầu chuyển chủ cho ${safeMemberName(exactTarget)}. Yêu cầu có hiệu lực 60 giây.`,
    'success'
  );

  return true;
}

async function handleRoomTransferButton(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    useCooldown(
      interaction,
      'room_transfer'
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn thao tác quá nhanh.',
      'warning'
    );
  }

  if (
    getPendingTransfer(
      context.channel.id
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Phòng đang có một yêu cầu chuyển chủ chờ xử lý.',
      'warning'
    );
  }

  const absence =
    await getOwnerAbsence(
      context.channel.id
    );

  if (absence) {
    return tempInteractionNotice(
      interaction,
      'Không thể chuyển chủ thủ công khi phòng đang trong thời gian bảo lưu chủ.',
      'warning'
    );
  }

  const target =
    await requireSelectedMemberInExactRoom(
      interaction,
      context
    );

  if (!target) {
    return;
  }

  const owned =
    await getOwnedRoom(
      interaction.guildId,
      target.id
    );

  if (
    owned &&
    String(
      owned.channel_id
    ) !==
    String(
      context.channel.id
    )
  ) {
    await acknowledgeComponent(
      interaction
    );

    await finishSelectedMemberAction(
      interaction,
      context
    );

    return tempFollowUp(
      interaction,
      `${safeMemberName(target)} đang sở hữu một phòng khác nên chưa thể nhận phòng này.`,
      'warning'
    );
  }

  await acknowledgeComponent(
    interaction
  );

  const finalCheck =
    await resolveMemberInExactRoom(
      interaction.guild,
      target.id,
      context.channel.id
    );

  if (!finalCheck) {
    await finishSelectedMemberAction(
      interaction,
      context
    );

    return tempFollowUp(
      interaction,
      `${safeMemberName(target)} không còn có mặt trong phòng này.`,
      'warning'
    );
  }

  const created =
    await createTransferRequest(
      interaction,
      context,
      finalCheck
    );

  if (!created) {
    return;
  }

  await finishSelectedMemberAction(
    interaction,
    context
  );
}

async function sendActionLog(
  guild,
  action,
  actor,
  channel,
  detail = ''
) {
  if (!guild) {
    return null;
  }

  try {
    const generator =
      await getGenerator(
        guild.id
      );

    if (
      !generator?.action_log_channel_id
    ) {
      return null;
    }

    const logChannel =
      await fetchChannelSafe(
        guild,
        generator.action_log_channel_id
      );

    if (
      !isTextChannel(
        logChannel
      )
    ) {
      return null;
    }

    const actorText =
      actor?.id
        ? `<@${actor.id}>`
        : 'Hệ thống';

    const channelText =
      channel?.id
        ? `<#${channel.id}>`
        : 'Không xác định';

    const lines = [
      `**${action}**`,
      `👤 ${actorText}`,
      `🔊 ${channelText}`,
      `🕒 ${vietnamTime()}`
    ];

    if (detail) {
      lines.push(
        `📝 ${String(detail).slice(
          0,
          1500
        )}`
      );
    }

    return await logChannel.send({
      content:
        lines.join('\n'),

      allowedMentions: {
        parse: []
      }
    });
  } catch (error) {
    logError(
      'ACTION_LOG',
      error
    );

    return null;
  }
}
async function editTransferResultMessage(
  channel,
  transfer,
  content
) {
  if (
    !channel ||
    !transfer?.messageId
  ) {
    return;
  }

  const message =
    await fetchMessageSafe(
      channel,
      transfer.messageId
    );

  if (!message) {
    return;
  }

  try {
    await message.edit({
      content,
      components: [],
      allowedMentions: {
        parse: []
      }
    });

    scheduleMessageDelete(
      message,
      NOTICE_DELETE_MS
    );
  } catch (error) {
    logError(
      'EDIT_TRANSFER_RESULT',
      error
    );
  }
}

async function transferRoomOwnership(
  guild,
  channel,
  room,
  newOwnerId,
  reason
) {
  const oldOwnerId =
    String(
      room.owner_id
    );

  const targetId =
    String(
      newOwnerId
    );

  if (
    oldOwnerId ===
    targetId
  ) {
    return {
      ok: true,
      room
    };
  }

  const target =
    await fetchMemberSafe(
      guild,
      targetId
    );

  if (
    !target ||
    target.user?.bot
  ) {
    return {
      ok: false,
      reason:
        'TARGET_INVALID'
    };
  }

  const targetOwnedRoom =
    await getOwnedRoom(
      guild.id,
      target.id
    );

  if (
    targetOwnedRoom &&
    String(
      targetOwnedRoom.channel_id
    ) !==
    String(
      channel.id
    )
  ) {
    return {
      ok: false,
      reason:
        'TARGET_HAS_ROOM'
    };
  }

  const db =
    await pool.connect();

  let updatedRoom =
    null;

  try {
    await db.query(
      'BEGIN'
    );

    const lockedRoomResult =
      await db.query(
        `
          SELECT *
          FROM rooms
          WHERE channel_id = $1
          FOR UPDATE
        `,
        [
          String(
            channel.id
          )
        ]
      );

    const lockedRoom =
      lockedRoomResult.rows[0];

    if (!lockedRoom) {
      await db.query(
        'ROLLBACK'
      );

      return {
        ok: false,
        reason:
          'ROOM_MISSING'
      };
    }

    if (
      String(
        lockedRoom.owner_id
      ) !==
      oldOwnerId
    ) {
      await db.query(
        'ROLLBACK'
      );

      return {
        ok: false,
        reason:
          'OWNER_CHANGED'
      };
    }

    const otherRoomResult =
      await db.query(
        `
          SELECT channel_id
          FROM rooms
          WHERE
            guild_id = $1
            AND owner_id = $2
            AND channel_id <> $3
          LIMIT 1
          FOR UPDATE
        `,
        [
          String(
            guild.id
          ),
          targetId,
          String(
            channel.id
          )
        ]
      );

    if (
      otherRoomResult.rowCount >
      0
    ) {
      await db.query(
        'ROLLBACK'
      );

      return {
        ok: false,
        reason:
          'TARGET_HAS_ROOM'
      };
    }

    updatedRoom =
      await updateRoomOwner(
        channel.id,
        targetId,
        db
      );

    if (!updatedRoom) {
      throw new Error(
        'UPDATE_ROOM_OWNER_RETURNED_NULL'
      );
    }

    await db.query(
      `
        DELETE FROM owner_absence
        WHERE channel_id = $1
      `,
      [
        String(
          channel.id
        )
      ]
    );

    await db.query(
      'COMMIT'
    );
  } catch (error) {
    await db.query(
      'ROLLBACK'
    ).catch(
      () => {}
    );

    logError(
      'TRANSFER_ROOM_DATABASE',
      error
    );

    return {
      ok: false,
      reason:
        'DATABASE_FAILED'
    };
  } finally {
    db.release();
  }

  const granted =
    await grantRoomOwnerPermissions(
      channel,
      targetId
    );

  if (!granted) {
    try {
      await updateRoomOwner(
        channel.id,
        oldOwnerId
      );

      await grantRoomOwnerPermissions(
        channel,
        oldOwnerId
      );
    } catch (error) {
      logError(
        'TRANSFER_PERMISSION_ROLLBACK',
        error
      );
    }

    return {
      ok: false,
      reason:
        'PERMISSION_FAILED'
    };
  }

  const revoked =
    await revokeRoomOwnerPermissions(
      channel,
      oldOwnerId
    );

  if (!revoked) {
    logError(
      'TRANSFER_OLD_OWNER_PERMISSION',
      new Error(
        `Không thể xóa overwrite của chủ cũ ${oldOwnerId}`
      )
    );
  }

  clearSelectedMember(
    guild.id,
    channel.id,
    oldOwnerId
  );

  clearSelectedMember(
    guild.id,
    channel.id,
    targetId
  );

  clearOwnerAbsenceTimer(
    channel.id
  );

  clearPendingTransfer(
    channel.id
  );

  await refreshRoomPanelSafe(
    channel.id
  );

  return {
    ok: true,
    room:
      updatedRoom,
    oldOwnerId,
    newOwnerId:
      targetId,
    reason
  };
}

async function handleTransferAccept(
  interaction,
  channelId
) {
  const transfer =
    getPendingTransfer(
      channelId
    );

  if (!transfer) {
    return tempInteractionNotice(
      interaction,
      'Yêu cầu chuyển chủ đã hết hạn hoặc không còn tồn tại.',
      'warning'
    );
  }

  if (
    String(
      interaction.user.id
    ) !==
    String(
      transfer.targetId
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Chỉ người được đề nghị nhận phòng mới có thể Đồng ý.',
      'warning'
    );
  }

  if (
    String(
      interaction.guildId
    ) !==
    String(
      transfer.guildId
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Yêu cầu chuyển chủ không hợp lệ.',
      'warning'
    );
  }

  await acknowledgeComponent(
    interaction
  );

  const room =
    await getRoom(
      channelId
    );

  if (!room) {
    clearPendingTransfer(
      channelId
    );

    return tempFollowUp(
      interaction,
      'Phòng không còn được Voice HDK quản lý.',
      'warning'
    );
  }

  if (
    String(
      room.owner_id
    ) !==
    String(
      transfer.ownerId
    )
  ) {
    clearPendingTransfer(
      channelId
    );

    return tempFollowUp(
      interaction,
      'Chủ phòng đã thay đổi nên yêu cầu này không còn hiệu lực.',
      'warning'
    );
  }

  const channel =
    await fetchChannelSafe(
      interaction.guild,
      channelId
    );

  if (
    !isVoiceChannel(
      channel
    )
  ) {
    clearPendingTransfer(
      channelId
    );

    return tempFollowUp(
      interaction,
      'Phòng thoại không còn tồn tại.',
      'warning'
    );
  }

  const target =
    await resolveMemberInExactRoom(
      interaction.guild,
      transfer.targetId,
      channel.id
    );

  if (!target) {
    clearPendingTransfer(
      channel.id
    );

    await editTransferResultMessage(
      channel,
      transfer,
      `🟠 Yêu cầu chuyển chủ đã hủy vì <@${transfer.targetId}> không còn trong phòng.`
    );

    return tempFollowUp(
      interaction,
      'Bạn phải còn ở đúng phòng này khi nhận quyền chủ.',
      'warning'
    );
  }

  const finalRoom =
    await getRoom(
      channel.id
    );

  if (
    !finalRoom ||
    String(
      finalRoom.owner_id
    ) !==
    String(
      transfer.ownerId
    )
  ) {
    clearPendingTransfer(
      channel.id
    );

    await editTransferResultMessage(
      channel,
      transfer,
      '🟠 Yêu cầu chuyển chủ đã bị hủy vì chủ phòng đã thay đổi.'
    );

    return tempFollowUp(
      interaction,
      'Yêu cầu này không còn hiệu lực.',
      'warning'
    );
  }

  const finalTarget =
    await resolveMemberInExactRoom(
      interaction.guild,
      transfer.targetId,
      channel.id
    );

  if (!finalTarget) {
    clearPendingTransfer(
      channel.id
    );

    await editTransferResultMessage(
      channel,
      transfer,
      `🟠 Yêu cầu chuyển chủ đã hủy vì <@${transfer.targetId}> không còn trong phòng.`
    );

    return tempFollowUp(
      interaction,
      'Bạn không còn ở trong phòng này.',
      'warning'
    );
  }

  const result =
    await transferRoomOwnership(
      interaction.guild,
      channel,
      finalRoom,
      finalTarget.id,
      'MANUAL_TRANSFER'
    );

  if (!result.ok) {
    if (
      result.reason ===
      'TARGET_HAS_ROOM'
    ) {
      clearPendingTransfer(
        channel.id
      );

      await editTransferResultMessage(
        channel,
        transfer,
        `🟠 Không thể chuyển chủ vì <@${finalTarget.id}> đang sở hữu một phòng khác.`
      );

      return tempFollowUp(
        interaction,
        'Bạn đang sở hữu một phòng khác nên không thể nhận thêm phòng này.',
        'warning'
      );
    }

    if (
      result.reason ===
      'OWNER_CHANGED'
    ) {
      clearPendingTransfer(
        channel.id
      );

      await editTransferResultMessage(
        channel,
        transfer,
        '🟠 Yêu cầu chuyển chủ đã bị hủy vì chủ phòng đã thay đổi.'
      );

      return tempFollowUp(
        interaction,
        'Yêu cầu chuyển chủ không còn hiệu lực.',
        'warning'
      );
    }

    return tempFollowUp(
      interaction,
      'Không thể hoàn tất chuyển chủ. Quyền sở hữu chưa được thay đổi.',
      'error'
    );
  }

  await editTransferResultMessage(
    channel,
    transfer,
    `🟢 <@${finalTarget.id}> đã trở thành chủ phòng mới.`
  );

  await sendActionLog(
    interaction.guild,
    'Chuyển chủ phòng',
    interaction.user,
    channel,
    `<@${result.oldOwnerId}> → <@${result.newOwnerId}>`
  );

  return tempFollowUp(
    interaction,
    'Bạn đã trở thành chủ phòng.',
    'success'
  );
}

async function handleTransferDecline(
  interaction,
  channelId
) {
  const transfer =
    getPendingTransfer(
      channelId
    );

  if (!transfer) {
    return tempInteractionNotice(
      interaction,
      'Yêu cầu chuyển chủ đã hết hạn hoặc không còn tồn tại.',
      'warning'
    );
  }

  if (
    String(
      interaction.user.id
    ) !==
    String(
      transfer.targetId
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Chỉ người được đề nghị nhận phòng mới có thể Từ chối.',
      'warning'
    );
  }

  await acknowledgeComponent(
    interaction
  );

  const guild =
    interaction.guild;

  const channel =
    await fetchChannelSafe(
      guild,
      channelId
    );

  clearPendingTransfer(
    channelId
  );

  if (
    isVoiceChannel(
      channel
    )
  ) {
    await editTransferResultMessage(
      channel,
      transfer,
      `🔴 <@${transfer.targetId}> đã từ chối nhận quyền chủ phòng.`
    );

    await sendActionLog(
      guild,
      'Từ chối chuyển chủ',
      interaction.user,
      channel,
      `Người nhận: <@${transfer.targetId}>`
    );
  }

  return tempFollowUp(
    interaction,
    'Bạn đã từ chối nhận quyền chủ phòng.',
    'success'
  );
}

async function deleteOwnerAbsenceNotice(
  guild,
  absence
) {
  if (
    !guild ||
    !absence?.channel_id ||
    !absence?.notice_message_id
  ) {
    return;
  }

  const channel =
    await fetchChannelSafe(
      guild,
      absence.channel_id
    );

  if (
    !isVoiceChannel(
      channel
    )
  ) {
    return;
  }

  const message =
    await fetchMessageSafe(
      channel,
      absence.notice_message_id
    );

  if (message) {
    await safeDeleteMessage(
      message
    );
  }
}

async function cancelOwnerAbsence(
  guild,
  channelId,
  returned = false
) {
  const absence =
    await getOwnerAbsence(
      channelId
    );

  clearOwnerAbsenceTimer(
    channelId
  );

  if (!absence) {
    return false;
  }

  await deleteOwnerAbsenceNotice(
    guild,
    absence
  );

  try {
    await deleteOwnerAbsence(
      channelId
    );
  } catch (error) {
    logError(
      'DELETE_OWNER_ABSENCE',
      error
    );

    return false;
  }

  if (returned) {
    const channel =
      await fetchChannelSafe(
        guild,
        channelId
      );

    if (
      isVoiceChannel(
        channel
      )
    ) {
      await sendTemporaryChannelNotice(
        channel,
        'Chủ phòng đã quay lại. Quyền chủ được giữ nguyên.',
        'success'
      );
    }
  }

  return true;
}

async function createOwnerAbsenceNotice(
  channel,
  ownerId,
  deadlineAt
) {
  if (
    !isVoiceChannel(
      channel
    )
  ) {
    return null;
  }

  try {
    return await channel.send({
      content: [
        `👑 <@${ownerId}> đã rời phòng.`,
        `Quyền chủ được bảo lưu đến ${relativeTimestamp(
          deadlineAt
        )}.`,
        'Nếu chủ phòng không quay lại, Voice HDK sẽ tự chuyển chủ cho thành viên hợp lệ đã ở trong phòng lâu nhất.'
      ].join('\n'),

      allowedMentions: {
        users: [
          String(
            ownerId
          )
        ]
      }
    });
  } catch (error) {
    logError(
      'OWNER_ABSENCE_NOTICE',
      error
    );

    return null;
  }
}

async function getEligibleAutoTransferCandidate(
  guild,
  channel,
  currentOwnerId
) {
  const presenceRows =
    await getRoomPresence(
      channel.id
    );

  const currentHumans =
    humanMembers(
      channel
    );

  const humanIds =
    new Set(
      currentHumans.map(
        member =>
          String(
            member.id
          )
      )
    );

  for (
    const row
    of presenceRows
  ) {
    const memberId =
      String(
        row.member_id
      );

    if (
      memberId ===
      String(
        currentOwnerId
      )
    ) {
      continue;
    }

    if (
      !humanIds.has(
        memberId
      )
    ) {
      continue;
    }

    const member =
      await resolveMemberInExactRoom(
        guild,
        memberId,
        channel.id
      );

    if (
      !member ||
      member.user?.bot
    ) {
      continue;
    }

    const ownedRoom =
      await getOwnedRoom(
        guild.id,
        member.id
      );

    if (
      ownedRoom &&
      String(
        ownedRoom.channel_id
      ) !==
      String(
        channel.id
      )
    ) {
      continue;
    }

    return member;
  }

  for (
    const member
    of currentHumans
  ) {
    if (
      String(
        member.id
      ) ===
      String(
        currentOwnerId
      )
    ) {
      continue;
    }

    const ownedRoom =
      await getOwnedRoom(
        guild.id,
        member.id
      );

    if (
      ownedRoom &&
      String(
        ownedRoom.channel_id
      ) !==
      String(
        channel.id
      )
    ) {
      continue;
    }

    await recordMemberPresence(
      guild.id,
      channel.id,
      member.id,
      new Date()
    );

    return member;
  }

  return null;
}
async function deleteManagedEmptyRoom(
  guild,
  channelId
) {
  return withRoomLifecycleLock(
    channelId,
    async () => {
      const room =
        await getRoom(
          channelId
        );

      if (!room) {
        clearRoomRuntimeState(
          channelId
        );

        return true;
      }

      const channel =
        await fetchChannelSafe(
          guild,
          channelId
        );

      if (!channel) {
        try {
          await deleteRoomRecord(
            channelId
          );

          clearRoomRuntimeState(
            channelId
          );

          return true;
        } catch (error) {
          logError(
            'DELETE_MISSING_ROOM_RECORD',
            error
          );

          return false;
        }
      }

      if (
        !isVoiceChannel(
          channel
        )
      ) {
        return false;
      }

      if (
        humanMembers(
          channel
        ).length >
        0
      ) {
        return false;
      }

      const deleted =
        await safeDeleteChannel(
          channel,
          `${BOT_NAME} xóa phòng trống`
        );

      if (!deleted) {
        return false;
      }

      try {
        await deleteRoomRecord(
          channelId
        );
      } catch (error) {
        logError(
          'DELETE_EMPTY_ROOM_DATABASE',
          error
        );

        return false;
      }

      clearRoomRuntimeState(
        channelId
      );

      return true;
    }
  );
}

function scheduleEmptyManagedRoomCheck(
  guild,
  channelId
) {
  clearEmptyRoomTimer(
    channelId
  );

  const timer =
    setTimeout(
      async () => {
        emptyRoomTimers.delete(
          String(
            channelId
          )
        );

        try {
          await deleteManagedEmptyRoom(
            guild,
            channelId
          );
        } catch (error) {
          logError(
            'EMPTY_ROOM_TIMER',
            error
          );
        }
      },
      EMPTY_ROOM_DELETE_DELAY_MS
    );

  timer.unref?.();

  emptyRoomTimers.set(
    String(
      channelId
    ),
    timer
  );
}

async function executeOwnerAbsenceDeadline(
  guild,
  channelId
) {
  const room =
    await getRoom(
      channelId
    );

  if (!room) {
    clearOwnerAbsenceTimer(
      channelId
    );

    return;
  }

  const absence =
    await getOwnerAbsence(
      channelId
    );

  if (!absence) {
    clearOwnerAbsenceTimer(
      channelId
    );

    return;
  }

  if (
    String(
      absence.owner_id
    ) !==
    String(
      room.owner_id
    )
  ) {
    await cancelOwnerAbsence(
      guild,
      channelId,
      false
    );

    return;
  }

  const channel =
    await fetchChannelSafe(
      guild,
      channelId
    );

  if (
    !isVoiceChannel(
      channel
    )
  ) {
    try {
      await deleteRoomRecord(
        channelId
      );
    } catch (error) {
      logError(
        'ABSENCE_MISSING_CHANNEL',
        error
      );
    }

    clearRoomRuntimeState(
      channelId
    );

    return;
  }

  const ownerInRoom =
    await memberIsInExactRoom(
      guild,
      room.owner_id,
      channel.id
    );

  if (ownerInRoom) {
    await cancelOwnerAbsence(
      guild,
      channel.id,
      true
    );

    return;
  }

  const humans =
    humanMembers(
      channel
    );

  if (
    humans.length ===
    0
  ) {
    await deleteManagedEmptyRoom(
      guild,
      channel.id
    );

    return;
  }

  const candidate =
    await getEligibleAutoTransferCandidate(
      guild,
      channel,
      room.owner_id
    );

  if (!candidate) {
    const retryDeadline =
      Date.now() +
      AUTO_TRANSFER_RETRY_MS;

    try {
      await saveOwnerAbsence({
        guildId:
          guild.id,

        channelId:
          channel.id,

        ownerId:
          room.owner_id,

        deadlineAt:
          new Date(
            retryDeadline
          ),

        noticeMessageId:
          absence.notice_message_id
      });
    } catch (error) {
      logError(
        'AUTO_TRANSFER_RETRY_DB',
        error
      );
    }

    clearOwnerAbsenceTimer(
      channel.id
    );

    const timer =
      setTimeout(
        () => {
          executeOwnerAbsenceDeadline(
            guild,
            channel.id
          ).catch(
            error => {
              logError(
                'AUTO_TRANSFER_RETRY',
                error
              );
            }
          );
        },
        AUTO_TRANSFER_RETRY_MS
      );

    timer.unref?.();

    ownerAbsenceTimers.set(
      String(
        channel.id
      ),
      timer
    );

    return;
  }

  const finalCandidate =
    await resolveMemberInExactRoom(
      guild,
      candidate.id,
      channel.id
    );

  if (!finalCandidate) {
    clearOwnerAbsenceTimer(
      channel.id
    );

    const timer =
      setTimeout(
        () => {
          executeOwnerAbsenceDeadline(
            guild,
            channel.id
          ).catch(
            error => {
              logError(
                'AUTO_TRANSFER_RACE_RETRY',
                error
              );
            }
          );
        },
        AUTO_TRANSFER_RETRY_MS
      );

    timer.unref?.();

    ownerAbsenceTimers.set(
      String(
        channel.id
      ),
      timer
    );

    return;
  }

  const result =
    await transferRoomOwnership(
      guild,
      channel,
      room,
      finalCandidate.id,
      'AUTO_TRANSFER'
    );

  if (!result.ok) {
    clearOwnerAbsenceTimer(
      channel.id
    );

    const timer =
      setTimeout(
        () => {
          executeOwnerAbsenceDeadline(
            guild,
            channel.id
          ).catch(
            error => {
              logError(
                'AUTO_TRANSFER_FAILED_RETRY',
                error
              );
            }
          );
        },
        AUTO_TRANSFER_RETRY_MS
      );

    timer.unref?.();

    ownerAbsenceTimers.set(
      String(
        channel.id
      ),
      timer
    );

    return;
  }

  await deleteOwnerAbsenceNotice(
    guild,
    absence
  );

  await sendTemporaryChannelNotice(
    channel,
    `<@${finalCandidate.id}> đã trở thành chủ phòng mới.`,
    'success'
  );

  await sendActionLog(
    guild,
    'Tự động chuyển chủ',
    null,
    channel,
    `<@${room.owner_id}> → <@${finalCandidate.id}>`
  );
}

async function scheduleOwnerAbsence(
  guild,
  channel,
  room
) {
  if (
    !guild ||
    !isVoiceChannel(
      channel
    ) ||
    !room
  ) {
    return;
  }

  const existing =
    await getOwnerAbsence(
      channel.id
    );

  if (existing) {
    return;
  }

  const ownerStillInRoom =
    await memberIsInExactRoom(
      guild,
      room.owner_id,
      channel.id
    );

  if (ownerStillInRoom) {
    return;
  }

  const humans =
    humanMembers(
      channel
    );

  if (
    humans.length ===
    0
  ) {
    scheduleEmptyManagedRoomCheck(
      guild,
      channel.id
    );

    return;
  }

  const deadlineAt =
    Date.now() +
    OWNER_ABSENCE_GRACE_MS;

  const notice =
    await createOwnerAbsenceNotice(
      channel,
      room.owner_id,
      deadlineAt
    );

  try {
    await saveOwnerAbsence({
      guildId:
        guild.id,

      channelId:
        channel.id,

      ownerId:
        room.owner_id,

      deadlineAt:
        new Date(
          deadlineAt
        ),

      noticeMessageId:
        notice?.id ||
        null
    });
  } catch (error) {
    logError(
      'SAVE_OWNER_ABSENCE',
      error
    );

    if (notice) {
      await safeDeleteMessage(
        notice
      );
    }

    return;
  }

  clearOwnerAbsenceTimer(
    channel.id
  );

  const timer =
    setTimeout(
      () => {
        executeOwnerAbsenceDeadline(
          guild,
          channel.id
        ).catch(
          error => {
            logError(
              'OWNER_ABSENCE_TIMER',
              error
            );
          }
        );
      },
      OWNER_ABSENCE_GRACE_MS
    );

  timer.unref?.();

  ownerAbsenceTimers.set(
    String(
      channel.id
    ),
    timer
  );
}

async function handleManagedRoomMemberJoin(
  guild,
  channel,
  member
) {
  if (
    !guild ||
    !isVoiceChannel(
      channel
    ) ||
    !isHumanMember(
      member
    )
  ) {
    return;
  }

  const room =
    await getRoom(
      channel.id
    );

  if (!room) {
    return;
  }

  clearEmptyRoomTimer(
    channel.id
  );

  await recordMemberPresence(
    guild.id,
    channel.id,
    member.id,
    new Date()
  );

  if (
    String(
      member.id
    ) ===
    String(
      room.owner_id
    )
  ) {
    await cancelOwnerAbsence(
      guild,
      channel.id,
      true
    );
  }

  await refreshRoomPanelSafe(
    channel.id
  );
}

async function handleManagedRoomMemberLeave(
  guild,
  channel,
  member
) {
  if (
    !guild ||
    !isVoiceChannel(
      channel
    ) ||
    !isHumanMember(
      member
    )
  ) {
    return;
  }

  const room =
    await getRoom(
      channel.id
    );

  if (!room) {
    return;
  }

  await removeMemberPresence(
    channel.id,
    member.id
  );

  const currentChannel =
    await fetchChannelSafe(
      guild,
      channel.id
    );

  if (
    !isVoiceChannel(
      currentChannel
    )
  ) {
    return;
  }

  const humans =
    humanMembers(
      currentChannel
    );

  if (
    humans.length ===
    0
  ) {
    await cancelOwnerAbsence(
      guild,
      channel.id,
      false
    );

    scheduleEmptyManagedRoomCheck(
      guild,
      channel.id
    );

    return;
  }

  if (
    String(
      member.id
    ) ===
    String(
      room.owner_id
    )
  ) {
    const actualOwnerChannel =
      getMemberVoiceChannelId(
        guild,
        room.owner_id
      );

    if (
      String(
        actualOwnerChannel ||
        ''
      ) !==
      String(
        channel.id
      )
    ) {
      await scheduleOwnerAbsence(
        guild,
        currentChannel,
        room
      );
    }
  }

  await refreshRoomPanelSafe(
    channel.id
  );
}

async function handleManagedVoiceTransition(
  oldState,
  newState
) {
  const guild =
    newState.guild ||
    oldState.guild;

  const member =
    newState.member ||
    oldState.member;

  if (
    !guild ||
    !member ||
    member.user?.bot
  ) {
    return;
  }

  const oldChannelId =
    oldState.channelId
      ? String(
          oldState.channelId
        )
      : null;

  const newChannelId =
    newState.channelId
      ? String(
          newState.channelId
        )
      : null;

  if (
    oldChannelId ===
    newChannelId
  ) {
    return;
  }

  if (oldChannelId) {
    const oldRoom =
      await getRoom(
        oldChannelId
      );

    if (oldRoom) {
      const oldChannel =
        await fetchChannelSafe(
          guild,
          oldChannelId
        );

      if (
        isVoiceChannel(
          oldChannel
        )
      ) {
        await handleManagedRoomMemberLeave(
          guild,
          oldChannel,
          member
        );
      }
    }
  }

  if (newChannelId) {
    const newRoom =
      await getRoom(
        newChannelId
      );

    if (newRoom) {
      const newChannel =
        await fetchChannelSafe(
          guild,
          newChannelId
        );

      if (
        isVoiceChannel(
          newChannel
        )
      ) {
        await handleManagedRoomMemberJoin(
          guild,
          newChannel,
          member
        );
      }
    }
  }
}
async function handleClaimCommand(
  interaction
) {
  if (
    !interaction.inGuild()
  ) {
    return tempReply(
      interaction,
      'Lệnh này chỉ sử dụng trong Server.',
      'warning'
    );
  }

  const voiceChannelId =
    getMemberVoiceChannelId(
      interaction.guild,
      interaction.user.id
    );

  if (!voiceChannelId) {
    return tempReply(
      interaction,
      'Bạn phải ở trong một phòng Voice HDK để nhận quyền chủ.',
      'warning'
    );
  }

  const room =
    await getRoom(
      voiceChannelId
    );

  if (!room) {
    return tempReply(
      interaction,
      'Phòng hiện tại không thuộc Voice HDK.',
      'warning'
    );
  }

  if (
    String(
      room.owner_id
    ) ===
    String(
      interaction.user.id
    )
  ) {
    return tempReply(
      interaction,
      'Bạn đã là chủ phòng này.',
      'warning'
    );
  }

  const absence =
    await getOwnerAbsence(
      room.channel_id
    );

  if (absence) {
    return tempReply(
      interaction,
      `Chủ phòng đang được bảo lưu quyền đến ${relativeTimestamp(
        absence.deadline_at
      )}.`,
      'warning'
    );
  }

  const channel =
    await fetchChannelSafe(
      interaction.guild,
      room.channel_id
    );

  if (
    !isVoiceChannel(
      channel
    )
  ) {
    return tempReply(
      interaction,
      'Phòng thoại không còn tồn tại.',
      'warning'
    );
  }

  const claimant =
    await resolveMemberInExactRoom(
      interaction.guild,
      interaction.user.id,
      channel.id
    );

  if (!claimant) {
    return tempReply(
      interaction,
      'Bạn không còn ở trong phòng này.',
      'warning'
    );
  }

  const ownerInRoom =
    await memberIsInExactRoom(
      interaction.guild,
      room.owner_id,
      channel.id
    );

  if (ownerInRoom) {
    return tempReply(
      interaction,
      'Chủ phòng hiện vẫn đang ở trong phòng.',
      'warning'
    );
  }

  const ownedRoom =
    await getOwnedRoom(
      interaction.guildId,
      claimant.id
    );

  if (
    ownedRoom &&
    String(
      ownedRoom.channel_id
    ) !==
    String(
      channel.id
    )
  ) {
    return tempReply(
      interaction,
      'Bạn đang sở hữu một phòng khác nên không thể nhận thêm phòng.',
      'warning'
    );
  }

  await interaction.deferReply({
    ephemeral: true
  });

  const finalRoom =
    await getRoom(
      channel.id
    );

  if (
    !finalRoom ||
    String(
      finalRoom.owner_id
    ) !==
    String(
      room.owner_id
    )
  ) {
    await interaction.editReply({
      content:
        buildNoticeText(
          'Chủ phòng vừa thay đổi. Hãy kiểm tra lại.',
          'warning'
        )
    });

    scheduleOriginalReplyDelete(
      interaction
    );

    return;
  }

  const finalAbsence =
    await getOwnerAbsence(
      channel.id
    );

  if (finalAbsence) {
    await interaction.editReply({
      content:
        buildNoticeText(
          `Chủ phòng đang được bảo lưu quyền đến ${relativeTimestamp(
            finalAbsence.deadline_at
          )}.`,
          'warning'
        )
    });

    scheduleOriginalReplyDelete(
      interaction
    );

    return;
  }

  const finalOwnerInRoom =
    await memberIsInExactRoom(
      interaction.guild,
      finalRoom.owner_id,
      channel.id
    );

  const finalClaimant =
    await resolveMemberInExactRoom(
      interaction.guild,
      claimant.id,
      channel.id
    );

  if (
    finalOwnerInRoom ||
    !finalClaimant
  ) {
    await interaction.editReply({
      content:
        buildNoticeText(
          'Điều kiện nhận phòng vừa thay đổi. Không thể thực hiện /claim.',
          'warning'
        )
    });

    scheduleOriginalReplyDelete(
      interaction
    );

    return;
  }

  const result =
    await transferRoomOwnership(
      interaction.guild,
      channel,
      finalRoom,
      finalClaimant.id,
      'CLAIM'
    );

  if (!result.ok) {
    await interaction.editReply({
      content:
        buildNoticeText(
          result.reason ===
            'TARGET_HAS_ROOM'
            ? 'Bạn đang sở hữu một phòng khác.'
            : 'Không thể nhận quyền chủ phòng lúc này.',
          'error'
        )
    });

    scheduleOriginalReplyDelete(
      interaction
    );

    return;
  }

  await sendTemporaryChannelNotice(
    channel,
    `<@${finalClaimant.id}> đã nhận quyền chủ phòng.`,
    'success'
  );

  await sendActionLog(
    interaction.guild,
    'Nhận quyền chủ',
    interaction.user,
    channel,
    `<@${result.oldOwnerId}> → <@${result.newOwnerId}>`
  );

  await interaction.editReply({
    content:
      buildNoticeText(
        'Bạn đã trở thành chủ phòng.',
        'success'
      )
  });

  scheduleOriginalReplyDelete(
    interaction
  );
}

async function restoreOwnerAbsenceTimer(
  guild,
  room,
  absence
) {
  if (
    !guild ||
    !room ||
    !absence
  ) {
    return;
  }

  const channel =
    await fetchChannelSafe(
      guild,
      room.channel_id
    );

  if (
    !isVoiceChannel(
      channel
    )
  ) {
    return;
  }

  const ownerInRoom =
    await memberIsInExactRoom(
      guild,
      room.owner_id,
      channel.id
    );

  if (ownerInRoom) {
    await cancelOwnerAbsence(
      guild,
      channel.id,
      false
    );

    return;
  }

  if (
    humanMembers(
      channel
    ).length ===
    0
  ) {
    await cancelOwnerAbsence(
      guild,
      channel.id,
      false
    );

    scheduleEmptyManagedRoomCheck(
      guild,
      channel.id
    );

    return;
  }

  const deadline =
    new Date(
      absence.deadline_at
    ).getTime();

  const delay =
    Math.max(
      0,
      deadline -
        Date.now()
    );

  clearOwnerAbsenceTimer(
    channel.id
  );

  const timer =
    setTimeout(
      () => {
        executeOwnerAbsenceDeadline(
          guild,
          channel.id
        ).catch(
          error => {
            logError(
              'RESTORED_ABSENCE_TIMER',
              error
            );
          }
        );
      },
      delay
    );

  timer.unref?.();

  ownerAbsenceTimers.set(
    String(
      channel.id
    ),
    timer
  );
}

async function synchronizeManagedRoomPresence(
  guild,
  channel,
  room
) {
  if (
    !guild ||
    !isVoiceChannel(
      channel
    ) ||
    !room
  ) {
    return;
  }

  const humans =
    humanMembers(
      channel
    );

  const currentIds =
    new Set(
      humans.map(
        member =>
          String(
            member.id
          )
      )
    );

  const stored =
    await getRoomPresence(
      channel.id
    );

  for (
    const row
    of stored
  ) {
    if (
      !currentIds.has(
        String(
          row.member_id
        )
      )
    ) {
      await removeMemberPresence(
        channel.id,
        row.member_id
      );
    }
  }

  const storedIds =
    new Set(
      stored.map(
        row =>
          String(
            row.member_id
          )
      )
    );

  for (
    const member
    of humans
  ) {
    if (
      !storedIds.has(
        String(
          member.id
        )
      )
    ) {
      await recordMemberPresence(
        guild.id,
        channel.id,
        member.id,
        new Date()
      );
    }
  }
}

/* =========================================================
   P7 — FINAL RUNTIME / COMPATIBILITY / EVENTS / LOGGING
   ========================================================= */


/* =========================================================
   1. COMPATIBILITY BRIDGE
   Không cần quay lại sửa P1 → P6
   ========================================================= */

function getMemberVoiceChannelId(
  guild,
  memberId
) {
  if (
    !guild ||
    !memberId
  ) {
    return null;
  }

  return (
    guild.voiceStates.cache.get(
      String(memberId)
    )?.channelId ||
    null
  );
}

function scheduleOriginalReplyDelete(
  interaction,
  delay = NOTICE_DELETE_MS
) {
  if (!interaction) {
    return;
  }

  const timer =
    setTimeout(
      async () => {
        try {
          if (
            interaction.deferred ||
            interaction.replied
          ) {
            await interaction.deleteReply();
          }
        } catch (_) {}
      },
      delay
    );

  timer.unref?.();
}

function clearOwnerAbsenceTimer(
  channelId
) {
  return clearRuntimeOwnerAbsenceTimer(
    channelId
  );
}

function isTextChannel(
  channel
) {
  if (!channel) {
    return false;
  }

  return Boolean(
    channel.isTextBased?.() &&
    typeof channel.send ===
      'function'
  );
}

async function revokeRoomOwnerPermissions(
  channel,
  ownerId
) {
  if (
    !channel ||
    !ownerId
  ) {
    return false;
  }

  return safePermissionDelete(
    channel,
    ownerId,
    `${BOT_NAME} thu hồi quyền trực tiếp của chủ phòng cũ`
  );
}


/*
 * P2 ban đầu nhận:
 *   safeDisconnectMember(member, expectedChannelId, reason)
 *
 * P5/P6 gọi:
 *   safeDisconnectMember(guild, memberId, expectedChannelId, reason)
 *
 * Chuẩn hóa ở đây để toàn bộ file hoạt động thống nhất.
 */
const _safeDisconnectMemberP2 =
  safeDisconnectMember;

safeDisconnectMember =
  async function (
    arg1,
    arg2,
    arg3,
    arg4
  ) {
    /*
     * Kiểu mới:
     * guild, memberId, expectedChannelId, reason
     */
    if (
      arg1?.members &&
      typeof arg2 ===
        'string'
    ) {
      const guild =
        arg1;

      const memberId =
        String(arg2);

      const expectedChannelId =
        String(arg3);

      const reason =
        arg4 ||
        `${BOT_NAME} ngắt kết nối thành viên`;

      let member;

      try {
        member =
          await guild.members.fetch({
            user:
              memberId,
            force:
              true
          });
      } catch (_) {
        member =
          await fetchMemberSafe(
            guild,
            memberId
          );
      }

      if (!member) {
        return {
          ok: false,
          reason:
            'MEMBER_MISSING'
        };
      }

      const currentVoice =
        guild.voiceStates.cache.get(
          memberId
        )?.channelId ||
        member.voice?.channelId ||
        null;

      if (
        String(
          currentVoice ||
          ''
        ) !==
        expectedChannelId
      ) {
        return {
          ok: false,
          reason:
            'NOT_IN_ROOM'
        };
      }

      try {
        await member.voice.disconnect(
          reason
        );
      } catch (error) {
        logError(
          'SAFE_DISCONNECT_FINAL',
          error
        );

        return {
          ok: false,
          reason:
            'DISCONNECT_FAILED'
        };
      }

      return {
        ok: true,
        reason: null
      };
    }

    /*
     * Giữ tương thích nếu helper cũ được gọi ở đâu đó.
     */
    try {
      const result =
        await _safeDisconnectMemberP2(
          arg1,
          arg2,
          arg3
        );

      if (
        result &&
        typeof result ===
          'object' &&
        'ok' in result
      ) {
        return result;
      }

      return {
        ok:
          Boolean(result),
        reason:
          result
            ? null
            : 'DISCONNECT_FAILED'
      };
    } catch (error) {
      logError(
        'SAFE_DISCONNECT_COMPAT',
        error
      );

      return {
        ok: false,
        reason:
          'DISCONNECT_FAILED'
      };
    }
  };


/* =========================================================
   2. CHAT LOG HELPERS
   ========================================================= */

function truncateLogText(
  value,
  max = 3500
) {
  const text =
    String(
      value ??
      ''
    );

  if (
    text.length <=
    max
  ) {
    return text;
  }

  return (
    text.slice(
      0,
      Math.max(
        0,
        max - 1
      )
    ) +
    '…'
  );
}

function messageAuthorText(
  message
) {
  const memberName =
    cleanDisplayName(
      message.member?.displayName
    );

  const username =
    cleanDisplayName(
      message.author?.username
    );

  return (
    memberName ||
    username ||
    'Không xác định'
  );
}

function messageChannelText(
  message
) {
  if (
    message.channelId
  ) {
    return `<#${message.channelId}>`;
  }

  return 'Không xác định';
}

function messageJumpUrl(
  message
) {
  return (
    message?.url ||
    (
      message?.guildId &&
      message?.channelId &&
      message?.id
        ? `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`
        : null
    )
  );
}

async function getTrackedChatLogChannel(
  guild
) {
  if (!guild) {
    return null;
  }

  const generator =
    await getGenerator(
      guild.id
    );

  if (
    !generator?.chat_log_channel_id
  ) {
    return null;
  }

  const channel =
    await fetchChannelSafe(
      guild,
      generator.chat_log_channel_id
    );

  if (
    !isTextChannel(
      channel
    )
  ) {
    return null;
  }

  return channel;
}

async function shouldIgnoreChatLogMessage(
  message
) {
  if (
    !message ||
    !message.guild ||
    message.author?.bot
  ) {
    return true;
  }

  const generator =
    await getGenerator(
      message.guild.id
    );

  if (!generator) {
    return true;
  }

  const ignored =
    new Set(
      [
        generator.chat_log_channel_id,
        generator.action_log_channel_id
      ]
        .filter(Boolean)
        .map(String)
    );

  return ignored.has(
    String(
      message.channelId
    )
  );
}

async function downloadAttachmentForArchive(
  attachment
) {
  if (
    !attachment?.url
  ) {
    return {
      ok: false,
      reason:
        'NO_URL'
    };
  }

  /*
   * Giới hạn bảo thủ để log không thất bại vì file lớn.
   * File lớn hơn sẽ vẫn được ghi metadata + URL.
   */
  const ARCHIVE_LIMIT =
    8 * 1024 * 1024;

  if (
    Number(
      attachment.size ||
      0
    ) >
    ARCHIVE_LIMIT
  ) {
    return {
      ok: false,
      reason:
        'TOO_LARGE'
    };
  }

  try {
    const response =
      await fetch(
        attachment.url
      );

    if (!response.ok) {
      return {
        ok: false,
        reason:
          `HTTP_${response.status}`
      };
    }

    const arrayBuffer =
      await response.arrayBuffer();

    const buffer =
      Buffer.from(
        arrayBuffer
      );

    if (
      buffer.length >
      ARCHIVE_LIMIT
    ) {
      return {
        ok: false,
        reason:
          'TOO_LARGE'
      };
    }

    return {
      ok: true,
      buffer
    };
  } catch (error) {
    logError(
      'DOWNLOAD_LOG_ATTACHMENT',
      error
    );

    return {
      ok: false,
      reason:
        'DOWNLOAD_FAILED'
    };
  }
}

async function archiveMessageAttachments(
  attachments
) {
  const files = [];
  const metadata = [];

  if (!attachments) {
    return {
      files,
      metadata
    };
  }
    for (
    const attachment
    of attachments.values()
  ) {
    const name =
      cleanDisplayName(
        attachment.name
      ) ||
      `attachment-${attachment.id}`;

    const size =
      Number(
        attachment.size ||
        0
      );

    const archived =
      await downloadAttachmentForArchive(
        attachment
      );

    if (archived.ok) {
      files.push({
        attachment:
          archived.buffer,
        name:
          name.slice(
            0,
            200
          )
      });

      metadata.push(
        `📎 ${name} • ${size} bytes • đã lưu`
      );
    } else {
      metadata.push(
        [
          `⚠️ ${name}`,
          `${size} bytes`,
          `không lưu được file (${archived.reason})`,
          attachment.url
        ].join(' • ')
      );
    }
  }

  return {
    files,
    metadata
  };
}

async function logCreatedMessage(
  message
) {
  if (
    await shouldIgnoreChatLogMessage(
      message
    )
  ) {
    return;
  }

  const logChannel =
    await getTrackedChatLogChannel(
      message.guild
    );

  if (!logChannel) {
    return;
  }

  const archived =
    await archiveMessageAttachments(
      message.attachments
    );

  const content =
    truncateLogText(
      message.content ||
      '(không có nội dung chữ)',
      3000
    );

  const lines = [
    '💬 **TIN NHẮN MỚI**',
    `👤 ${messageAuthorText(message)} • <@${message.author.id}>`,
    `📍 ${messageChannelText(message)}`,
    `🕒 ${vietnamTime(
      message.createdAt
    )}`,
    '',
    content
  ];

  if (
    archived.metadata.length
  ) {
    lines.push(
      '',
      ...archived.metadata
    );
  }

  const jump =
    messageJumpUrl(
      message
    );

  if (jump) {
    lines.push(
      '',
      `🔗 ${jump}`
    );
  }

  try {
    await logChannel.send({
      content:
        truncateLogText(
          lines.join('\n'),
          1900
        ),

      files:
        archived.files,

      allowedMentions: {
        parse: []
      }
    });
  } catch (error) {
    logError(
      'CHAT_LOG_CREATE',
      error
    );

    /*
     * Nếu upload attachment làm message log lỗi,
     * vẫn cố ghi metadata.
     */
    if (
      archived.files.length
    ) {
      try {
        await logChannel.send({
          content:
            truncateLogText(
              [
                ...lines,
                '',
                '⚠️ Discord từ chối upload một hoặc nhiều attachment vào log.'
              ].join('\n'),
              1900
            ),

          allowedMentions: {
            parse: []
          }
        });
      } catch (fallbackError) {
        logError(
          'CHAT_LOG_CREATE_FALLBACK',
          fallbackError
        );
      }
    }
  }
}

async function hydratePartialMessage(
  message
) {
  if (!message) {
    return null;
  }

  if (!message.partial) {
    return message;
  }

  try {
    return await message.fetch();
  } catch (_) {
    return message;
  }
}

async function logEditedMessage(
  oldMessage,
  newMessage
) {
  newMessage =
    await hydratePartialMessage(
      newMessage
    );

  if (
    !newMessage?.guild ||
    newMessage.author?.bot
  ) {
    return;
  }

  if (
    await shouldIgnoreChatLogMessage(
      newMessage
    )
  ) {
    return;
  }

  const oldContent =
    String(
      oldMessage?.content ??
      '(không lấy được nội dung cũ)'
    );

  const newContent =
    String(
      newMessage?.content ??
      '(không có nội dung chữ)'
    );

  if (
    oldContent ===
      newContent &&
    oldMessage?.attachments?.size ===
      newMessage?.attachments?.size
  ) {
    return;
  }

  const logChannel =
    await getTrackedChatLogChannel(
      newMessage.guild
    );

  if (!logChannel) {
    return;
  }

  const lines = [
    '✏️ **TIN NHẮN ĐÃ SỬA**',
    `👤 ${messageAuthorText(newMessage)} • <@${newMessage.author.id}>`,
    `📍 ${messageChannelText(newMessage)}`,
    `🕒 ${vietnamTime()}`,
    '',
    '**Trước:**',
    truncateLogText(
      oldContent,
      650
    ),
    '',
    '**Sau:**',
    truncateLogText(
      newContent,
      650
    )
  ];

  const jump =
    messageJumpUrl(
      newMessage
    );

  if (jump) {
    lines.push(
      '',
      `🔗 ${jump}`
    );
  }

  try {
    await logChannel.send({
      content:
        truncateLogText(
          lines.join('\n'),
          1900
        ),

      allowedMentions: {
        parse: []
      }
    });
  } catch (error) {
    logError(
      'CHAT_LOG_EDIT',
      error
    );
  }
}

async function logDeletedMessage(
  message
) {
  message =
    await hydratePartialMessage(
      message
    );

  if (
    !message?.guild ||
    message.author?.bot
  ) {
    return;
  }

  if (
    await shouldIgnoreChatLogMessage(
      message
    )
  ) {
    return;
  }

  const logChannel =
    await getTrackedChatLogChannel(
      message.guild
    );

  if (!logChannel) {
    return;
  }

  const attachmentLines = [];

  for (
    const attachment
    of message.attachments?.values?.() ||
    []
  ) {
    attachmentLines.push(
      `📎 ${attachment.name || attachment.id} • ${attachment.url}`
    );
  }

  const lines = [
    '🗑️ **TIN NHẮN ĐÃ XÓA**',
    `👤 ${messageAuthorText(message)}${
      message.author?.id
        ? ` • <@${message.author.id}>`
        : ''
    }`,
    `📍 ${messageChannelText(message)}`,
    `🕒 ${vietnamTime()}`,
    '',
    truncateLogText(
      message.content ||
      '(không lấy được nội dung chữ)',
      1200
    )
  ];

  if (
    attachmentLines.length
  ) {
    lines.push(
      '',
      ...attachmentLines
    );
  }

  try {
    await logChannel.send({
      content:
        truncateLogText(
          lines.join('\n'),
          1900
        ),

      allowedMentions: {
        parse: []
      }
    });
  } catch (error) {
    logError(
      'CHAT_LOG_DELETE',
      error
    );
  }
}


/* =========================================================
   3. COMMANDS
   ========================================================= */

const VOICE_HDK_COMMANDS = [
  new SlashCommandBuilder()
    .setName(
      'setup'
    )
    .setDescription(
      'Cài đặt hoặc quản lý Voice HDK'
    ),

  new SlashCommandBuilder()
    .setName(
      'claim'
    )
    .setDescription(
      'Nhận quyền chủ phòng khi đủ điều kiện'
    ),

  new SlashCommandBuilder()
    .setName(
      'panel'
    )
    .setDescription(
      'Khôi phục panel của phòng Voice HDK hiện tại'
    )
].map(
  command =>
    command.toJSON()
);

async function registerGuildCommands(
  guild
) {
  if (
    !guild?.commands
  ) {
    return false;
  }

  try {
    await guild.commands.set(
      VOICE_HDK_COMMANDS
    );

    return true;
  } catch (error) {
    logError(
      `REGISTER_COMMANDS:${guild.id}`,
      error
    );

    return false;
  }
}

async function handlePanelCommand(
  interaction
) {
  if (
    !interaction.inGuild()
  ) {
    return tempReply(
      interaction,
      'Lệnh này chỉ sử dụng trong Server.',
      'warning'
    );
  }

  const voiceChannelId =
    getMemberVoiceChannelId(
      interaction.guild,
      interaction.user.id
    );

  if (!voiceChannelId) {
    return tempReply(
      interaction,
      'Bạn phải ở trong phòng Voice HDK.',
      'warning'
    );
  }

  const room =
    await getRoom(
      voiceChannelId
    );

  if (!room) {
    return tempReply(
      interaction,
      'Phòng hiện tại không thuộc Voice HDK.',
      'warning'
    );
  }

  if (
    String(
      room.owner_id
    ) !==
    String(
      interaction.user.id
    )
  ) {
    return tempReply(
      interaction,
      'Chỉ chủ phòng mới có thể khôi phục panel.',
      'warning'
    );
  }

  await interaction.deferReply({
    ephemeral: true
  });

  const panel =
    await refreshRoomPanelSafe(
      room.channel_id
    );

  await interaction.editReply({
    content:
      buildNoticeText(
        panel
          ? 'Panel phòng đã được kiểm tra và đồng bộ.'
          : 'Không thể khôi phục panel phòng.',
        panel
          ? 'success'
          : 'error'
      )
  });

  scheduleOriginalReplyDelete(
    interaction
  );
}


/* =========================================================
   4. INTERACTION ROUTER
   ========================================================= */

async function routeInteraction(
  interaction
) {
  if (
    interaction.isChatInputCommand()
  ) {
    switch (
      interaction.commandName
    ) {
      case 'setup':
        return handleSetupCommand(
          interaction
        );

      case 'claim':
        return handleClaimCommand(
          interaction
        );

      case 'panel':
        return handlePanelCommand(
          interaction
        );

      default:
        return;
    }
  }

  if (
    interaction.isModalSubmit()
  ) {
    switch (
      interaction.customId
    ) {
      case 'setup_display_name_modal':
        return handleSetupDisplayNameModal(
          interaction
        );

      case 'room_rename_modal':
        return handleRoomRenameModal(
          interaction
        );

      case 'room_limit_modal':
        return handleRoomLimitModal(
          interaction
        );

      default:
        return;
    }
  }

  if (
    interaction.isUserSelectMenu()
  ) {
    if (
      interaction.customId ===
      'room_member_select'
    ) {
      return handleRoomMemberSelect(
        interaction
      );
    }

    return;
  }

  if (
    interaction.isChannelSelectMenu()
  ) {
    switch (
      interaction.customId
    ) {
      case 'setup_button_category':
        return handleSetupButtonCategory(
          interaction
        );

      case 'setup_blog_category':
        return handleSetupBlogCategory(
          interaction
        );

      default:
        return;
    }
  }

  if (
    interaction.isStringSelectMenu()
  ) {
    if (
      interaction.customId ===
      'room_region'
    ) {
      return handleRoomRegion(
        interaction
      );
    }

    return;
  }

  if (
    !interaction.isButton()
  ) {
    return;
  }

  const customId =
    interaction.customId;

  if (
    customId.startsWith(
      'transfer_accept:'
    )
  ) {
    const channelId =
      customId.split(':')[1];

    if (
      !isSnowflake(
        channelId
      )
    ) {
      return tempInteractionNotice(
        interaction,
        'Yêu cầu chuyển chủ không hợp lệ.',
        'warning'
      );
    }

    return handleTransferAccept(
      interaction,
      channelId
    );
  }

  if (
    customId.startsWith(
      'transfer_decline:'
    )
  ) {
    const channelId =
      customId.split(':')[1];

    if (
      !isSnowflake(
        channelId
      )
    ) {
      return tempInteractionNotice(
        interaction,
        'Yêu cầu chuyển chủ không hợp lệ.',
        'warning'
      );
    }

    return handleTransferDecline(
      interaction,
      channelId
    );
  }

  switch (
    customId
  ) {
    case 'setup_install':
      return handleSetupInstallButton(
        interaction
      );

    case 'setup_button_category':
      return handleSetupButtonCategory(
        interaction
      );

    case 'setup_blog_category':
      return handleSetupBlogCategory(
        interaction
      );

    case 'setup_continue':
      return handleSetupContinue(
        interaction
      );

    case 'setup_cancel':
      return handleSetupCancel(
        interaction
      );

    case 'setup_uninstall':
      return handleSetupUninstallButton(
        interaction
      );

    case 'setup_uninstall_confirm':
      return handleSetupUninstallConfirm(
        interaction
      );

    case 'setup_uninstall_cancel':
      return handleSetupUninstallCancel(
        interaction
      );

    case 'room_lock':
      return handleRoomLock(
        interaction
      );

    case 'room_hide':
      return handleRoomHide(
        interaction
      );

    case 'room_rename':
      return handleRoomRenameButton(
        interaction
      );

    case 'room_reset':
      return handleRoomReset(
        interaction
      );

    case 'room_limit':
      return handleRoomLimitButton(
        interaction
      );

    case 'room_invite':
      return handleRoomInvite(
        interaction
      );

    case 'room_transfer':
      return handleRoomTransferButton(
        interaction
      );

    case 'room_deny':
      return handleRoomDeny(
        interaction
      );

    case 'room_kick':
      return handleRoomKick(
        interaction
      );

    default:
      return;
  }
}


/* =========================================================
   5. CHANNEL DELETE RECONCILE
   Không tự hồi sinh Generator / Log
   ========================================================= */

async function clearMissingTrackedChannel(
  guild,
  channelId
) {
  if (
    !guild ||
    !channelId
  ) {
    return;
  }

  const generator =
    await getGenerator(
      guild.id
    );

  if (!generator) {
    return;
  }

  const id =
    String(
      channelId
    );

  if (
    String(
      generator.create_voice_id ||
      ''
    ) === id
  ) {
    try {
      await pool.query(
        `
          UPDATE generators
          SET create_voice_id = NULL
          WHERE guild_id = $1
        `,
        [
          String(
            guild.id
          )
        ]
      );
    } catch (error) {
      logError(
        'CLEAR_DELETED_GENERATOR',
        error
      );
    }

    return;
  }

  if (
    String(
      generator.chat_log_channel_id ||
      ''
    ) === id
  ) {
    try {
      await pool.query(
        `
          UPDATE generators
          SET chat_log_channel_id = NULL
          WHERE guild_id = $1
        `,
        [
          String(
            guild.id
          )
        ]
      );
    } catch (error) {
      logError(
        'CLEAR_DELETED_CHAT_LOG',
        error
      );
    }

    return;
  }

  if (
    String(
      generator.action_log_channel_id ||
      ''
    ) === id
  ) {
    try {
      await pool.query(
        `
          UPDATE generators
          SET action_log_channel_id = NULL
          WHERE guild_id = $1
        `,
        [
          String(
            guild.id
          )
        ]
      );
    } catch (error) {
      logError(
        'CLEAR_DELETED_ACTION_LOG',
        error
      );
    }
  }
}

async function handleDeletedManagedChannel(
  channel
) {
  if (
    !channel?.guild
  ) {
    return;
  }

  const guild =
    channel.guild;

  const channelId =
    String(
      channel.id
    );

  await clearMissingTrackedChannel(
    guild,
    channelId
  );

  const room =
    await getRoom(
      channelId
    );

  if (!room) {
    return;
  }

  clearRoomRuntimeState(
    channelId
  );

  try {
    await deleteRoomRecord(
      channelId
    );
  } catch (error) {
    logError(
      'CHANNEL_DELETE_ROOM_DB',
      error
    );
  }
}
/* =========================================================
   6. STARTUP RECONCILE
   ========================================================= */

async function reconcileTrackedGenerator(
  guild,
  generator
) {
  if (
    !generator
  ) {
    return;
  }

  if (
    generator.create_voice_id
  ) {
    const createVoice =
      await fetchChannelSafe(
        guild,
        generator.create_voice_id
      );

    if (
      !isVoiceChannel(
        createVoice
      )
    ) {
      try {
        await pool.query(
          `
            UPDATE generators
            SET create_voice_id = NULL
            WHERE guild_id = $1
          `,
          [
            String(
              guild.id
            )
          ]
        );
      } catch (error) {
        logError(
          'RECONCILE_GENERATOR',
          error
        );
      }
    } else {
      /*
       * Chỉ chỉnh vị trí generator còn tồn tại.
       * Tuyệt đối không tạo generator mới.
       */
      await positionGeneratorFirst(
        createVoice
      );
    }
  }

  if (
    generator.chat_log_channel_id
  ) {
    const channel =
      await fetchChannelSafe(
        guild,
        generator.chat_log_channel_id
      );

    if (
      !isTextChannel(
        channel
      )
    ) {
      try {
        await pool.query(
          `
            UPDATE generators
            SET chat_log_channel_id = NULL
            WHERE guild_id = $1
          `,
          [
            String(
              guild.id
            )
          ]
        );
      } catch (error) {
        logError(
          'RECONCILE_CHAT_LOG',
          error
        );
      }
    }
  }

  if (
    generator.action_log_channel_id
  ) {
    const channel =
      await fetchChannelSafe(
        guild,
        generator.action_log_channel_id
      );

    if (
      !isTextChannel(
        channel
      )
    ) {
      try {
        await pool.query(
          `
            UPDATE generators
            SET action_log_channel_id = NULL
            WHERE guild_id = $1
          `,
          [
            String(
              guild.id
            )
          ]
        );
      } catch (error) {
        logError(
          'RECONCILE_ACTION_LOG',
          error
        );
      }
    }
  }
}

async function reconcileManagedRoom(
  guild,
  room
) {
  const channel =
    await fetchChannelSafe(
      guild,
      room.channel_id
    );

  if (
    !isVoiceChannel(
      channel
    )
  ) {
    try {
      await deleteRoomRecord(
        room.channel_id
      );
    } catch (error) {
      logError(
        'RECONCILE_MISSING_ROOM',
        error
      );
    }

    clearRoomRuntimeState(
      room.channel_id
    );

    return;
  }

  await synchronizeManagedRoomPresence(
    guild,
    channel,
    room
  );

  const humans =
    humanMembers(
      channel
    );

  if (
    humans.length ===
    0
  ) {
    scheduleEmptyManagedRoomCheck(
      guild,
      channel.id
    );

    return;
  }

  await ensureOwnerDirectPermissions(
    channel,
    room.owner_id
  );

  await refreshRoomPanelSafe(
    channel.id
  );

  const ownerInRoom =
    await memberIsInExactRoom(
      guild,
      room.owner_id,
      channel.id
    );

  const absence =
    await getOwnerAbsence(
      channel.id
    );

  if (ownerInRoom) {
    if (absence) {
      await cancelOwnerAbsence(
        guild,
        channel.id,
        false
      );
    }

    return;
  }

  if (absence) {
    await restoreOwnerAbsenceTimer(
      guild,
      room,
      absence
    );

    return;
  }

  await scheduleOwnerAbsence(
    guild,
    channel,
    room
  );
}

async function reconcileGuildVoiceHDK(
  guild
) {
  if (!guild) {
    return;
  }

  try {
    const generator =
      await getGenerator(
        guild.id
      );

    if (generator) {
      await reconcileTrackedGenerator(
        guild,
        generator
      );
    }

    const rooms =
      await getGuildRooms(
        guild.id
      );

    for (
      const room
      of rooms
    ) {
      await reconcileManagedRoom(
        guild,
        room
      );
    }
  } catch (error) {
    logError(
      `RECONCILE_GUILD:${guild.id}`,
      error
    );
  }
}


/* =========================================================
   7. VOICE STATE EVENT
   ========================================================= */

async function handleVoiceStateUpdate(
  oldState,
  newState
) {
  const guild =
    newState.guild ||
    oldState.guild;

  const member =
    newState.member ||
    oldState.member;

  if (
    !guild ||
    !member ||
    member.user?.bot
  ) {
    return;
  }

  const oldChannelId =
    oldState.channelId
      ? String(
          oldState.channelId
        )
      : null;

  const newChannelId =
    newState.channelId
      ? String(
          newState.channelId
        )
      : null;

  if (
    oldChannelId ===
    newChannelId
  ) {
    return;
  }

  /*
   * Xử lý leave/join của managed room trước.
   * Các hàm bên P6 đều kiểm tra actual voice state.
   */
  await handleManagedVoiceTransition(
    oldState,
    newState
  );

  /*
   * Sau đó mới kiểm tra generator.
   * Nếu member đã rời generator trước khi lock chạy,
   * handleGeneratorJoin sẽ tự dừng.
   */
  if (newChannelId) {
    const generator =
      await getGenerator(
        guild.id
      );

    if (
      generator?.create_voice_id &&
      String(
        generator.create_voice_id
      ) ===
      newChannelId
    ) {
      await handleGeneratorJoin(
        guild,
        member,
        newChannelId
      );
    }
  }
}


/* =========================================================
   8. GLOBAL ERROR BOUNDARY CHO INTERACTION
   ========================================================= */

async function handleInteractionError(
  interaction,
  error
) {
  logError(
    `INTERACTION:${
      interaction?.customId ||
      interaction?.commandName ||
      'UNKNOWN'
    }`,
    error
  );

  if (
    !interaction?.isRepliable?.()
  ) {
    return;
  }

  const content =
    buildNoticeText(
      'Đã xảy ra lỗi khi xử lý thao tác. Dữ liệu an toàn đã được giữ nguyên.',
      'error'
    );

  try {
    if (
      interaction.deferred ||
      interaction.replied
    ) {
      await interaction.followUp({
        content,
        ephemeral:
          true
      });

      return;
    }

    await interaction.reply({
      content,
      ephemeral:
        true
    });

    scheduleOriginalReplyDelete(
      interaction
    );
  } catch (_) {}
}


/* =========================================================
   9. EVENT REGISTRATION
   ========================================================= */

client.on(
  Events.InteractionCreate,
  async interaction => {
    try {
      await routeInteraction(
        interaction
      );
    } catch (error) {
      await handleInteractionError(
        interaction,
        error
      );
    }
  }
);

client.on(
  Events.VoiceStateUpdate,
  async (
    oldState,
    newState
  ) => {
    try {
      await handleVoiceStateUpdate(
        oldState,
        newState
      );
    } catch (error) {
      logError(
        'VOICE_STATE_UPDATE',
        error
      );
    }
  }
);

client.on(
  Events.ChannelDelete,
  async channel => {
    try {
      await handleDeletedManagedChannel(
        channel
      );
    } catch (error) {
      logError(
        'CHANNEL_DELETE',
        error
      );
    }
  }
);

client.on(
  Events.MessageCreate,
  async message => {
    try {
      await logCreatedMessage(
        message
      );
    } catch (error) {
      logError(
        'MESSAGE_CREATE_LOG',
        error
      );
    }
  }
);

client.on(
  Events.MessageUpdate,
  async (
    oldMessage,
    newMessage
  ) => {
    try {
      await logEditedMessage(
        oldMessage,
        newMessage
      );
    } catch (error) {
      logError(
        'MESSAGE_UPDATE_LOG',
        error
      );
    }
  }
);

client.on(
  Events.MessageDelete,
  async message => {
    try {
      await logDeletedMessage(
        message
      );
    } catch (error) {
      logError(
        'MESSAGE_DELETE_LOG',
        error
      );
    }
  }
);

client.on(
  Events.GuildCreate,
  async guild => {
    try {
      await registerGuildCommands(
        guild
      );

      await reconcileGuildVoiceHDK(
        guild
      );
    } catch (error) {
      logError(
        'GUILD_CREATE',
        error
      );
    }
  }
);


/* =========================================================
   10. DATABASE STARTUP TEST
   Bot không login nếu PostgreSQL lỗi
   ========================================================= */

async function verifyDatabaseConnection() {
  const db =
    await pool.connect();

  try {
    await db.query(
      'SELECT 1 AS ok'
    );

    return true;
  } finally {
    db.release();
  }
}


/* =========================================================
   11. READY
   ========================================================= */

let startupReconcileDone =
  false;

client.once(
  Events.ClientReady,
  async readyClient => {
    console.log(
      `[${BOT_NAME}] Đăng nhập: ${readyClient.user.tag}`
    );

    console.log(
      `[${BOT_NAME}] Version: ${BOT_VERSION}`
    );

    console.log(
      `[${BOT_NAME}] Servers: ${readyClient.guilds.cache.size}`
    );

    try {
      /*
       * Guild command giúp /setup /claim /panel xuất hiện nhanh.
       */
      for (
        const guild
        of readyClient.guilds.cache.values()
      ) {
        await registerGuildCommands(
          guild
        );
      }

      if (
        !startupReconcileDone
      ) {
        startupReconcileDone =
          true;

        for (
          const guild
          of readyClient.guilds.cache.values()
        ) {
          await reconcileGuildVoiceHDK(
            guild
          );
        }
      }

      console.log(
        `[${BOT_NAME}] Startup reconcile hoàn tất.`
      );
    } catch (error) {
      logError(
        'CLIENT_READY_STARTUP',
        error
      );
    }
  }
);


/* =========================================================
   12. HEALTH SERVER
   ========================================================= */

let healthServer =
  null;

function startHealthServer() {
  if (healthServer) {
    return;
  }

  healthServer =
    http.createServer(
      (
        req,
        res
      ) => {
        if (
          req.url ===
          '/health' ||
          req.url ===
          '/'
        ) {
          const ready =
            client.isReady();

          const payload =
            JSON.stringify({
              ok:
                ready,
              service:
                BOT_NAME,
              version:
                BOT_VERSION,
              discord:
                ready
                  ? 'ready'
                  : 'starting',
              guilds:
                client.guilds.cache.size,
              uptime:
                Math.floor(
                  process.uptime()
                )
            });

          res.writeHead(
            ready
              ? 200
              : 503,
            {
              'Content-Type':
                'application/json; charset=utf-8',
              'Cache-Control':
                'no-store'
            }
          );

          res.end(
            payload
          );

          return;
        }

        res.writeHead(
          404,
          {
            'Content-Type':
              'text/plain; charset=utf-8'
          }
        );

        res.end(
          'Not Found'
        );
      }
    );

  healthServer.listen(
    PORT,
    '0.0.0.0',
    () => {
      console.log(
        `[${BOT_NAME}] Health server: port ${PORT}`
      );
    }
  );

  healthServer.on(
    'error',
    error => {
      logError(
        'HEALTH_SERVER',
        error
      );
    }
  );
}


/* =========================================================
   13. PROCESS ERROR HANDLING
   ========================================================= */

process.on(
  'unhandledRejection',
  error => {
    logError(
      'UNHANDLED_REJECTION',
      error
    );
  }
);

process.on(
  'uncaughtException',
  error => {
    logError(
      'UNCAUGHT_EXCEPTION',
      error
    );

    process.exit(1);
  }
);


/* =========================================================
   14. GRACEFUL SHUTDOWN
   ========================================================= */

async function shutdown(
  signal
) {
  if (shuttingDown) {
    return;
  }

  shuttingDown =
    true;

  console.log(
    `[${BOT_NAME}] Nhận ${signal}, đang tắt...`
  );

  for (
    const timer
    of emptyRoomTimers.values()
  ) {
    clearTimeout(
      timer
    );
  }

  emptyRoomTimers.clear();

  for (
    const timer
    of ownerAbsenceTimers.values()
  ) {
    clearTimeout(
      timer
    );
  }

  ownerAbsenceTimers.clear();

  for (
    const transfer
    of pendingTransfers.values()
  ) {
    if (
      transfer?.timer
    ) {
      clearTimeout(
        transfer.timer
      );
    }
  }

  pendingTransfers.clear();

  for (
    const session
    of setupSessions.values()
  ) {
    if (
      session?.timer
    ) {
      clearTimeout(
        session.timer
      );
    }
  }

  setupSessions.clear();

  try {
    client.destroy();
  } catch (_) {}

  if (healthServer) {
    try {
      await new Promise(
        resolve => {
          healthServer.close(
            () =>
              resolve()
          );
        }
      );
    } catch (_) {}
  }

  try {
    await pool.end();
  } catch (error) {
    logError(
      'POOL_SHUTDOWN',
      error
    );
  }

  process.exit(0);
}

process.once(
  'SIGTERM',
  () => {
    shutdown(
      'SIGTERM'
    );
  }
);

process.once(
  'SIGINT',
  () => {
    shutdown(
      'SIGINT'
    );
  }
);


/* =========================================================
   15. BOOT
   PostgreSQL phải OK trước Discord login
   ========================================================= */

async function bootVoiceHDK() {
  try {
    console.log(
      `[${BOT_NAME}] Đang kiểm tra PostgreSQL...`
    );

    await verifyDatabaseConnection();

    console.log(
      `[${BOT_NAME}] PostgreSQL OK.`
    );

    /*
     * P1 phải chứa hàm initDatabase().
     * Nếu P1 của bạn đặt tên là initializeDatabase(),
     * P1 mới đã được thiết kế để init trước login.
     *
     * Kiểm tra động để không gọi tên không tồn tại.
     */
    if (
      typeof initDatabase ===
      'function'
    ) {
      await initDatabase();
    } else if (
      typeof initializeDatabase ===
      'function'
    ) {
      await initializeDatabase();
    }

    console.log(
      `[${BOT_NAME}] Database schema OK.`
    );

    startHealthServer();

    await client.login(
      TOKEN
    );
  } catch (error) {
    logError(
      'BOOT_FATAL',
      error
    );

    console.error(
      `[${BOT_NAME}] Không khởi động Discord vì database/startup thất bại.`
    );

    try {
      if (healthServer) {
        healthServer.close();
      }
    } catch (_) {}

    try {
      await pool.end();
    } catch (_) {}

    process.exit(1);
  }
}
bootVoiceHDK();
