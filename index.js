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
  OverwriteType,
  MessageFlags
} = require('discord.js');

const { Pool } = require('pg');
const http = require('http');


/* =========================================================
   1. CONFIG
   ========================================================= */

const BOT_NAME = 'Voice HDK';

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
  throw new Error(
    'Thiếu biến môi trường DISCORD_TOKEN.'
  );
}

if (!DATABASE_URL) {
  throw new Error(
    'Thiếu biến môi trường DATABASE_URL.'
  );
}


/* =========================================================
   2. DISCORD CLIENT
   ========================================================= */

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


/* =========================================================
   3. POSTGRESQL
   ========================================================= */

const pool = new Pool({
  connectionString: DATABASE_URL
});

pool.on(
  'error',
  error => {
    logError(
      'POSTGRES_POOL',
      error
    );
  }
);


/* =========================================================
   4. RUNTIME STATE
   ========================================================= */

const panelLocks = new Map();
const createLocks = new Map();
const roomLifecycleLocks = new Map();

const cooldowns = new Map();
const selectedMembers = new Map();
const pendingTransfers = new Map();
const setupSessions = new Map();

const emptyRoomTimers = new Map();
const ownerAbsenceTimers = new Map();

/*
 * Khi /setup đang gỡ hoặc cài lại Voice HDK,
 * ChannelDelete / VoiceStateUpdate không được
 * chạy ngược lại quá trình cleanup.
 */
const setupCleanupGuilds = new Set();

let regionCache = {
  fetchedAt: 0,
  regions: []
};

let shuttingDown = false;


/* =========================================================
   5. UI / PERMISSIONS
   ========================================================= */

const UI_COLORS = {
  blue: 0x4f6faf,
  green: 0x4f8a68,
  orange: 0xb8793e,
  purple: 0x75639b
};

const REQUIRED_BOT_PERMISSIONS = {
  ViewChannel:
    PermissionsBitField.Flags.ViewChannel,

  SendMessages:
    PermissionsBitField.Flags.SendMessages,

  EmbedLinks:
    PermissionsBitField.Flags.EmbedLinks,

  ReadMessageHistory:
    PermissionsBitField.Flags.ReadMessageHistory,

  ManageChannels:
    PermissionsBitField.Flags.ManageChannels,

  ManageRoles:
    PermissionsBitField.Flags.ManageRoles,

  MoveMembers:
    PermissionsBitField.Flags.MoveMembers,

  Connect:
    PermissionsBitField.Flags.Connect
};


/* =========================================================
   6. BASIC HELPERS
   ========================================================= */

function logError(
  scope,
  error
) {
  const message =
    error?.stack ||
    error?.message ||
    String(error);

  console.error(
    `[${BOT_NAME}] [${scope}]`,
    message
  );
}

function isSnowflake(
  value
) {
  return (
    typeof value === 'string' &&
    /^\d{16,22}$/.test(value)
  );
}

function isVoiceChannel(
  channel
) {
  return Boolean(
    channel &&
    (
      channel.type ===
        ChannelType.GuildVoice ||
      channel.type ===
        ChannelType.GuildStageVoice
    )
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

function isCategoryChannel(
  channel
) {
  return Boolean(
    channel &&
    channel.type ===
      ChannelType.GuildCategory
  );
}

function cleanDisplayName(
  value
) {
  return String(
    value || ''
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function vietnamTime(
  date = new Date()
) {
  try {
    const parts =
      new Intl.DateTimeFormat(
        'vi-VN',
        {
          timeZone:
            TIME_ZONE,

          hour:
            '2-digit',

          minute:
            '2-digit',

          second:
            '2-digit',

          day:
            '2-digit',

          month:
            '2-digit',

          year:
            'numeric',

          hour12:
            false
        }
      )
        .formatToParts(
          date
        );

    const data = {};

    for (
      const part
      of parts
    ) {
      if (
        part.type !==
        'literal'
      ) {
        data[
          part.type
        ] =
          part.value;
      }
    }

    return (
      `${data.hour}:` +
      `${data.minute}:` +
      `${data.second} ` +
      `${data.day}/` +
      `${data.month}/` +
      `${data.year}`
    );
  } catch (_) {
    return date.toISOString();
  }
}

function truncateLogText(
  value,
  maxLength = 1900
) {
  const text =
    String(
      value || ''
    );

  if (
    text.length <=
    maxLength
  ) {
    return text;
  }

  return (
    text.slice(
      0,
      Math.max(
        0,
        maxLength - 1
      )
    ) +
    '…'
  );
}

async function fetchChannelSafe(
  guild,
  channelId
) {
  if (
    !guild ||
    !isSnowflake(
      String(
        channelId || ''
      )
    )
  ) {
    return null;
  }

  try {
    return (
      guild.channels.cache.get(
        String(channelId)
      ) ||
      await guild.channels.fetch(
        String(channelId)
      )
    );
  } catch (_) {
    return null;
  }
}

async function fetchMemberSafe(
  guild,
  memberId
) {
  if (
    !guild ||
    !isSnowflake(
      String(
        memberId || ''
      )
    )
  ) {
    return null;
  }

  try {
    return (
      guild.members.cache.get(
        String(memberId)
      ) ||
      await guild.members.fetch(
        String(memberId)
      )
    );
  } catch (_) {
    return null;
  }
}

async function safeDeleteChannel(
  channel,
  reason =
    `${BOT_NAME} cleanup`
) {
  if (!channel) {
    return true;
  }

  try {
    if (
      channel.deleted
    ) {
      return true;
    }

    await channel.delete(
      reason
    );

    return true;
  } catch (error) {
    logError(
      `DELETE_CHANNEL:${channel.id}`,
      error
    );

    return false;
  }
}


/* =========================================================
   7. RUNTIME CLEANUP
   ========================================================= */

function clearRoomRuntimeState(
  channelId
) {
  const id =
    String(channelId);

  const emptyTimer =
    emptyRoomTimers.get(
      id
    );

  if (emptyTimer) {
    clearTimeout(
      emptyTimer
    );

    emptyRoomTimers.delete(
      id
    );
  }

  const absenceTimer =
    ownerAbsenceTimers.get(
      id
    );

  if (absenceTimer) {
    clearTimeout(
      absenceTimer
    );

    ownerAbsenceTimers.delete(
      id
    );
  }

  const transfer =
    pendingTransfers.get(
      id
    );

  if (
    transfer?.timer
  ) {
    clearTimeout(
      transfer.timer
    );
  }

  pendingTransfers.delete(
    id
  );

  panelLocks.delete(
    id
  );

  roomLifecycleLocks.delete(
    id
  );

  for (
    const [key, state]
    of selectedMembers
  ) {
    if (
      String(
        state?.channelId ||
        ''
      ) === id
    ) {
      selectedMembers.delete(
        key
      );
    }
  }
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
        state?.guildId ||
        ''
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
        transfer?.guildId ||
        ''
      ) !== id
    ) {
      continue;
    }

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

  for (
    const [key, session]
    of setupSessions
  ) {
    if (
      String(
        session?.guildId ||
        ''
      ) !== id
    ) {
      continue;
    }

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

  for (
    const key
    of cooldowns.keys()
  ) {
    if (
      String(key)
        .startsWith(
          `${id}:`
        )
    ) {
      cooldowns.delete(
        key
      );
    }
  }
}


/* =========================================================
   8. DATABASE CONNECTION
   ========================================================= */

async function verifyDatabaseConnection() {
  const result =
    await pool.query(
      'SELECT NOW() AS now'
    );

  return Boolean(
    result.rows?.[0]?.now
  );
}


/* =========================================================
   9. DATABASE SCHEMA + LEGACY MIGRATION
   ========================================================= */

async function initDatabase() {
  const db =
    await pool.connect();

  try {
    await db.query(
      'BEGIN'
    );

    /*
     * -----------------------------------------------------
     * GENERATORS
     * -----------------------------------------------------
     */

    await db.query(`
      CREATE TABLE IF NOT EXISTS generators (
        guild_id TEXT PRIMARY KEY,
        display_name TEXT,
        button_category_id TEXT,
        blog_category_id TEXT,
        create_voice_id TEXT,
        chat_log_channel_id TEXT,
        action_log_channel_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await db.query(`
      ALTER TABLE generators
      ADD COLUMN IF NOT EXISTS display_name TEXT
    `);

    await db.query(`
      ALTER TABLE generators
      ADD COLUMN IF NOT EXISTS button_category_id TEXT
    `);

    await db.query(`
      ALTER TABLE generators
      ADD COLUMN IF NOT EXISTS blog_category_id TEXT
    `);

    await db.query(`
      ALTER TABLE generators
      ADD COLUMN IF NOT EXISTS create_voice_id TEXT
    `);

    await db.query(`
      ALTER TABLE generators
      ADD COLUMN IF NOT EXISTS chat_log_channel_id TEXT
    `);

    await db.query(`
      ALTER TABLE generators
      ADD COLUMN IF NOT EXISTS action_log_channel_id TEXT
    `);

    await db.query(`
      ALTER TABLE generators
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
    `);

    await db.query(`
      ALTER TABLE generators
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
    `);

    await db.query(`
      UPDATE generators
      SET created_at = NOW()
      WHERE created_at IS NULL
    `);

    await db.query(`
      UPDATE generators
      SET updated_at = NOW()
      WHERE updated_at IS NULL
    `);

    await db.query(`
      ALTER TABLE generators
      ALTER COLUMN created_at
      SET DEFAULT NOW()
    `);

    await db.query(`
      ALTER TABLE generators
      ALTER COLUMN updated_at
      SET DEFAULT NOW()
    `);


    /*
     * -----------------------------------------------------
     * ROOMS
     * -----------------------------------------------------
     */

    await db.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        category_id TEXT,
        control_message_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await db.query(`
      ALTER TABLE rooms
      ADD COLUMN IF NOT EXISTS category_id TEXT
    `);

    await db.query(`
      ALTER TABLE rooms
      ADD COLUMN IF NOT EXISTS control_message_id TEXT
    `);

    await db.query(`
      ALTER TABLE rooms
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
    `);

    await db.query(`
      ALTER TABLE rooms
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
    `);

    await db.query(`
      UPDATE rooms
      SET created_at = NOW()
      WHERE created_at IS NULL
    `);

    await db.query(`
      UPDATE rooms
      SET updated_at = NOW()
      WHERE updated_at IS NULL
    `);

    await db.query(`
      ALTER TABLE rooms
      ALTER COLUMN created_at
      SET DEFAULT NOW()
    `);

    await db.query(`
      ALTER TABLE rooms
      ALTER COLUMN updated_at
      SET DEFAULT NOW()
    `);


    /*
     * -----------------------------------------------------
     * ROOM PRESENCE
     * -----------------------------------------------------
     */

    await db.query(`
      CREATE TABLE IF NOT EXISTS room_presence (
        channel_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (
          channel_id,
          member_id
        )
      )
    `);

    await db.query(`
      ALTER TABLE room_presence
      ADD COLUMN IF NOT EXISTS guild_id TEXT
    `);

    await db.query(`
      ALTER TABLE room_presence
      ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ
    `);

    await db.query(`
      UPDATE room_presence
      SET joined_at = NOW()
      WHERE joined_at IS NULL
    `);

    await db.query(`
      ALTER TABLE room_presence
      ALTER COLUMN joined_at
      SET DEFAULT NOW()
    `);


    /*
     * -----------------------------------------------------
     * OWNER ABSENCE
     * -----------------------------------------------------
     */

    await db.query(`
      CREATE TABLE IF NOT EXISTS owner_absence (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        deadline_at TIMESTAMPTZ,
        notice_message_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await db.query(`
      ALTER TABLE owner_absence
      ADD COLUMN IF NOT EXISTS guild_id TEXT
    `);

    await db.query(`
      ALTER TABLE owner_absence
      ADD COLUMN IF NOT EXISTS owner_id TEXT
    `);

    await db.query(`
      ALTER TABLE owner_absence
      ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ
    `);

    await db.query(`
      ALTER TABLE owner_absence
      ADD COLUMN IF NOT EXISTS notice_message_id TEXT
    `);

    await db.query(`
      ALTER TABLE owner_absence
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
    `);

    await db.query(`
      ALTER TABLE owner_absence
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
    `);

    await db.query(`
      UPDATE owner_absence
      SET created_at = NOW()
      WHERE created_at IS NULL
    `);

    await db.query(`
      UPDATE owner_absence
      SET updated_at = NOW()
      WHERE updated_at IS NULL
    `);

    await db.query(`
      ALTER TABLE owner_absence
      ALTER COLUMN created_at
      SET DEFAULT NOW()
    `);

    await db.query(`
      ALTER TABLE owner_absence
      ALTER COLUMN updated_at
      SET DEFAULT NOW()
    `);


    /*
     * -----------------------------------------------------
     * ROOM BANS
     * -----------------------------------------------------
     */

    await db.query(`
      CREATE TABLE IF NOT EXISTS room_bans (
        channel_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        banned_by TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (
          channel_id,
          member_id
        )
      )
    `);

    await db.query(`
      ALTER TABLE room_bans
      ADD COLUMN IF NOT EXISTS guild_id TEXT
    `);

    await db.query(`
      ALTER TABLE room_bans
      ADD COLUMN IF NOT EXISTS banned_by TEXT
    `);

    await db.query(`
      ALTER TABLE room_bans
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
    `);

    await db.query(`
      UPDATE room_bans
      SET created_at = NOW()
      WHERE created_at IS NULL
    `);

    await db.query(`
      ALTER TABLE room_bans
      ALTER COLUMN created_at
      SET DEFAULT NOW()
    `);


    /*
     * -----------------------------------------------------
     * BACKFILL GUILD_ID CHO DATABASE CŨ
     * -----------------------------------------------------
     *
     * Nếu database cũ thiếu guild_id trong các bảng con,
     * lấy lại guild_id từ rooms theo channel_id.
     */

    await db.query(`
      UPDATE room_presence AS rp
      SET guild_id = r.guild_id
      FROM rooms AS r
      WHERE
        rp.channel_id = r.channel_id
        AND (
          rp.guild_id IS NULL
          OR rp.guild_id = ''
        )
    `);

    await db.query(`
      UPDATE owner_absence AS oa
      SET guild_id = r.guild_id
      FROM rooms AS r
      WHERE
        oa.channel_id = r.channel_id
        AND (
          oa.guild_id IS NULL
          OR oa.guild_id = ''
        )
    `);

    await db.query(`
      UPDATE room_bans AS rb
      SET guild_id = r.guild_id
      FROM rooms AS r
      WHERE
        rb.channel_id = r.channel_id
        AND (
          rb.guild_id IS NULL
          OR rb.guild_id = ''
        )
    `);


    /*
     * -----------------------------------------------------
     * CLEAN LEGACY ORPHANS
     * -----------------------------------------------------
     *
     * Chỉ xóa record con không thể xác định guild.
     * Không xóa generator / room hợp lệ.
     */

    await db.query(`
      DELETE FROM room_presence
      WHERE guild_id IS NULL
         OR guild_id = ''
    `);

    await db.query(`
      DELETE FROM owner_absence
      WHERE guild_id IS NULL
         OR guild_id = ''
    `);

    await db.query(`
      DELETE FROM room_bans
      WHERE guild_id IS NULL
         OR guild_id = ''
    `);


    /*
     * -----------------------------------------------------
     * INDEXES
     * -----------------------------------------------------
     */

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
      CREATE INDEX IF NOT EXISTS
        room_presence_oldest_idx
      ON room_presence (
        channel_id,
        joined_at ASC
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS
        room_presence_guild_idx
      ON room_presence (
        guild_id
      )
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS
        owner_absence_guild_idx
      ON owner_absence (
        guild_id
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


/* =========================================================
   10. GENERATOR DATABASE
   ========================================================= */

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
        ),
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

  return (
    result.rows[0] ||
    null
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


/* =========================================================
   11. ROOM DATABASE
   ========================================================= */

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

  return (
    result.rows ||
    []
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

async function createRoomRecord({
  channelId,
  guildId,
  ownerId,
  categoryId,
  controlMessageId = null
}) {
  const result =
    await pool.query(
      `
        INSERT INTO rooms (
          channel_id,
          guild_id,
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
        String(channelId),
        String(guildId),
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

async function updateRoomControlMessage(
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


/* =========================================================
   12. GUILD DATABASE CLEANUP
   ========================================================= */

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


/* =========================================================
   13. ROOM PRESENCE DATABASE
   ========================================================= */

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

async function clearRoomPresence(
  channelId
) {
  await pool.query(
    `
      DELETE FROM room_presence
      WHERE channel_id = $1
    `,
    [
      String(channelId)
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
        ORDER BY joined_at ASC
      `,
      [
        String(channelId)
      ]
    );

  return (
    result.rows ||
    []
  );
}


/* =========================================================
   14. OWNER ABSENCE DATABASE
   ========================================================= */

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

async function saveOwnerAbsence({
  channelId,
  guildId,
  ownerId,
  deadlineAt,
  noticeMessageId = null
}) {
  const result =
    await pool.query(
      `
        INSERT INTO owner_absence (
          channel_id,
          guild_id,
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
        String(channelId),
        String(guildId),
        String(ownerId),
        deadlineAt,
        noticeMessageId
          ? String(
              noticeMessageId
            )
          : null
      ]
    );

  return (
    result.rows[0] ||
    null
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


/* =========================================================
   15. ROOM BAN DATABASE
   ========================================================= */

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

async function addRoomBan(
  guildId,
  channelId,
  memberId,
  bannedBy
) {
  await pool.query(
    `
      INSERT INTO room_bans (
        channel_id,
        guild_id,
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
        guild_id =
          EXCLUDED.guild_id,

        banned_by =
          EXCLUDED.banned_by
    `,
    [
      String(channelId),
      String(guildId),
      String(memberId),
      bannedBy
        ? String(
            bannedBy
          )
        : null
    ]
  );
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

async function clearRoomBans(
  channelId
) {
  await pool.query(
    `
      DELETE FROM room_bans
      WHERE channel_id = $1
    `,
    [
      String(channelId)
    ]
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

  return (
    result.rows ||
    []
  );
}
/* =========================================================
   P2 — MEMBER / VOICE HELPERS
   ========================================================= */

function getMemberVoiceChannelId(
  member
) {
  return (
    member?.voice?.channelId
      ? String(
          member.voice.channelId
        )
      : null
  );
}

async function fetchMemberWithVoiceState(
  guild,
  memberId
) {
  if (
    !guild ||
    !isSnowflake(
      String(
        memberId || ''
      )
    )
  ) {
    return null;
  }

  try {
    /*
     * Luôn fetch lại member trước action nhạy cảm.
     * Không chỉ dựa vào cache cũ.
     */
    return await guild.members.fetch(
      String(memberId),
      {
        force: true
      }
    );
  } catch (_) {
    return fetchMemberSafe(
      guild,
      memberId
    );
  }
}

async function resolveMemberInExactRoom(
  guild,
  memberId,
  channelId
) {
  const member =
    await fetchMemberWithVoiceState(
      guild,
      memberId
    );

  if (!member) {
    return null;
  }

  const actualChannelId =
    getMemberVoiceChannelId(
      member
    );

  if (
    actualChannelId !==
    String(channelId)
  ) {
    return null;
  }

  return member;
}

async function memberIsInExactRoom(
  guild,
  memberId,
  channelId
) {
  const member =
    await resolveMemberInExactRoom(
      guild,
      memberId,
      channelId
    );

  return Boolean(
    member
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
      !member.user?.bot
  );
}


/* =========================================================
   P2 — SAFE VOICE ACTIONS
   ========================================================= */

async function safeMoveMember(
  member,
  channel,
  reason =
    `${BOT_NAME} di chuyển thành viên`
) {
  if (
    !member ||
    !channel
  ) {
    return false;
  }

  try {
    await member.voice.setChannel(
      channel,
      reason
    );

    return true;
  } catch (error) {
    logError(
      `MOVE_MEMBER:${member.id}`,
      error
    );

    return false;
  }
}

async function safeDisconnectMember(
  member,
  reason =
    `${BOT_NAME} ngắt kết nối thành viên`
) {
  if (!member) {
    return false;
  }

  try {
    await member.voice.disconnect(
      reason
    );

    return true;
  } catch (error) {
    logError(
      `DISCONNECT_MEMBER:${member.id}`,
      error
    );

    return false;
  }
}


/* =========================================================
   P2 — PERMISSION TARGET RESOLUTION
   ========================================================= */

async function resolvePermissionTarget(
  guild,
  target
) {
  if (
    !guild ||
    !target
  ) {
    return null;
  }

  if (
    typeof target ===
    'object'
  ) {
    if (
      target.id &&
      target.guild
    ) {
      return target;
    }

    if (
      target.id
    ) {
      target =
        target.id;
    }
  }

  const id =
    String(target);

  if (
    !isSnowflake(id)
  ) {
    return null;
  }

  const member =
    await fetchMemberSafe(
      guild,
      id
    );

  if (member) {
    return member;
  }

  try {
    const role =
      guild.roles.cache.get(
        id
      ) ||
      await guild.roles.fetch(
        id
      );

    if (role) {
      return role;
    }
  } catch (_) {}

  return null;
}

async function safePermissionEdit(
  channel,
  target,
  permissions,
  reason =
    `${BOT_NAME} cập nhật quyền phòng`
) {
  if (
    !channel?.guild ||
    !target
  ) {
    return false;
  }

  const resolved =
    await resolvePermissionTarget(
      channel.guild,
      target
    );

  if (!resolved) {
    return false;
  }

  try {
    await channel.permissionOverwrites.edit(
      resolved,
      permissions,
      {
        reason
      }
    );

    return true;
  } catch (error) {
    logError(
      `PERMISSION_EDIT:${channel.id}:${resolved.id}`,
      error
    );

    return false;
  }
}

async function safePermissionDelete(
  channel,
  target,
  reason =
    `${BOT_NAME} xóa quyền riêng`
) {
  if (
    !channel?.guild ||
    !target
  ) {
    return false;
  }

  const resolved =
    await resolvePermissionTarget(
      channel.guild,
      target
    );

  if (!resolved) {
    return false;
  }

  const overwrite =
    channel.permissionOverwrites.cache.get(
      resolved.id
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
    logError(
      `PERMISSION_DELETE:${channel.id}:${resolved.id}`,
      error
    );

    return false;
  }
}


/* =========================================================
   P2 — OWNER / INVITE / DENY PERMISSIONS
   ========================================================= */

async function grantRoomOwnerPermissions(
  channel,
  memberOrId
) {
  return safePermissionEdit(
    channel,
    memberOrId,
    {
      ViewChannel:
        true,

      Connect:
        true,

      Speak:
        true,

      Stream:
        true,

      UseVAD:
        true,

      MoveMembers:
        true,

      MuteMembers:
        true,

      DeafenMembers:
        true,

      ManageChannels:
        true
    },
    `${BOT_NAME} cấp quyền chủ phòng`
  );
}

async function revokeRoomOwnerPermissions(
  channel,
  memberOrId
) {
  if (
    !channel?.guild
  ) {
    return false;
  }

  const target =
    await resolvePermissionTarget(
      channel.guild,
      memberOrId
    );

  if (!target) {
    return false;
  }

  try {
    /*
     * Chủ cũ không được giữ bộ quyền quản lý
     * trực tiếp sau khi chuyển chủ.
     *
     * Xóa overwrite member-specific của chủ cũ
     * thay vì để các quyền ManageChannels /
     * MoveMembers tồn tại.
     */
    const overwrite =
      channel.permissionOverwrites.cache.get(
        target.id
      );

    if (!overwrite) {
      return true;
    }

    await overwrite.delete(
      `${BOT_NAME} thu hồi quyền chủ cũ`
    );

    return true;
  } catch (error) {
    logError(
      `REVOKE_OWNER:${channel.id}:${target.id}`,
      error
    );

    return false;
  }
}

async function grantInvitedMemberPermissions(
  channel,
  memberOrId
) {
  return safePermissionEdit(
    channel,
    memberOrId,
    {
      ViewChannel:
        true,

      Connect:
        true
    },
    `${BOT_NAME} mời thành viên vào phòng`
  );
}

async function denyMemberPermissions(
  channel,
  memberOrId
) {
  return safePermissionEdit(
    channel,
    memberOrId,
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
  memberOrId
) {
  return safePermissionDelete(
    channel,
    memberOrId,
    `${BOT_NAME} bỏ quyền riêng thành viên`
  );
}


/* =========================================================
   P2 — CLEAR MEMBER-SPECIFIC OVERWRITES
   ========================================================= */

async function clearMemberSpecificOverwrites(
  channel,
  preserveMemberIds = []
) {
  if (
    !channel?.guild
  ) {
    return;
  }

  const preserve =
    new Set(
      preserveMemberIds
        .filter(Boolean)
        .map(String)
    );

  const overwrites = [
    ...channel.permissionOverwrites.cache.values()
  ];

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

    try {
      await overwrite.delete(
        `${BOT_NAME} đặt lại quyền thành viên`
      );
    } catch (error) {
      logError(
        `CLEAR_MEMBER_OVERWRITE:${channel.id}:${overwrite.id}`,
        error
      );
    }
  }
}


/* =========================================================
   P2 — ENSURE OWNER PERMISSIONS
   ========================================================= */

async function ensureOwnerDirectPermissions(
  channel,
  ownerId
) {
  if (
    !channel?.guild ||
    !ownerId
  ) {
    return false;
  }

  const member =
    await fetchMemberSafe(
      channel.guild,
      ownerId
    );

  if (!member) {
    return false;
  }

  return grantRoomOwnerPermissions(
    channel,
    member
  );
}


/* =========================================================
   P2 — SELECTED MEMBER STATE
   ========================================================= */

function selectedMemberKey(
  guildId,
  userId
) {
  return (
    `${String(guildId)}:` +
    `${String(userId)}`
  );
}

function setSelectedMember(
  guildId,
  channelId,
  userId,
  memberId
) {
  const key =
    selectedMemberKey(
      guildId,
      userId
    );

  selectedMembers.set(
    key,
    {
      guildId:
        String(guildId),

      channelId:
        String(channelId),

      userId:
        String(userId),

      memberId:
        String(memberId),

      expiresAt:
        Date.now() +
        SELECTED_MEMBER_TIMEOUT_MS
    }
  );
}

function getSelectedMember(
  guildId,
  channelId,
  userId
) {
  const key =
    selectedMemberKey(
      guildId,
      userId
    );

  const state =
    selectedMembers.get(
      key
    );

  if (!state) {
    return null;
  }

  if (
    state.expiresAt <=
    Date.now()
  ) {
    selectedMembers.delete(
      key
    );

    return null;
  }

  if (
    String(
      state.guildId
    ) !==
      String(guildId) ||
    String(
      state.channelId
    ) !==
      String(channelId)
  ) {
    selectedMembers.delete(
      key
    );

    return null;
  }

  return state;
}

function clearSelectedMember(
  guildId,
  userId
) {
  selectedMembers.delete(
    selectedMemberKey(
      guildId,
      userId
    )
  );
}


/* =========================================================
   P2 — PENDING TRANSFER STATE
   ========================================================= */

function getPendingTransfer(
  channelId
) {
  const id =
    String(channelId);

  const transfer =
    pendingTransfers.get(
      id
    );

  if (!transfer) {
    return null;
  }

  if (
    transfer.expiresAt <=
    Date.now()
  ) {
    if (
      transfer.timer
    ) {
      clearTimeout(
        transfer.timer
      );
    }

    pendingTransfers.delete(
      id
    );

    return null;
  }

  return transfer;
}

function clearPendingTransfer(
  channelId
) {
  const id =
    String(channelId);

  const transfer =
    pendingTransfers.get(
      id
    );

  if (
    transfer?.timer
  ) {
    clearTimeout(
      transfer.timer
    );
  }

  pendingTransfers.delete(
    id
  );
}


/* =========================================================
   P2 — SETUP SESSION
   ========================================================= */

function setupSessionKey(
  guildId,
  userId
) {
  return (
    `${String(guildId)}:` +
    `${String(userId)}`
  );
}

function setSetupSession(
  guildId,
  userId
) {
  const key =
    setupSessionKey(
      guildId,
      userId
    );

  const old =
    setupSessions.get(
      key
    );

  if (
    old?.timer
  ) {
    clearTimeout(
      old.timer
    );
  }

  const session = {
    guildId:
      String(guildId),

    userId:
      String(userId),

    buttonCategoryId:
      null,

    blogCategoryId:
      null,

    expiresAt:
      Date.now() +
      SETUP_TIMEOUT_MS,

    timer:
      null
  };

  session.timer =
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

  if (
    typeof session.timer.unref ===
    'function'
  ) {
    session.timer.unref();
  }

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
    session.expiresAt <=
    Date.now()
  ) {
    if (
      session.timer
    ) {
      clearTimeout(
        session.timer
      );
    }

    setupSessions.delete(
      key
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
    changes || {}
  );

  return session;
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


/* =========================================================
   P2 — COOLDOWN
   ========================================================= */

function cooldownKey(
  guildId,
  userId,
  action
) {
  return [
    String(guildId),
    String(userId),
    String(action)
  ].join(':');
}

function takeCooldown(
  guildId,
  userId,
  action,
  duration =
    ACTION_COOLDOWN_MS
) {
  const key =
    cooldownKey(
      guildId,
      userId,
      action
    );

  const now =
    Date.now();

  const expiresAt =
    cooldowns.get(
      key
    ) || 0;

  if (
    expiresAt >
    now
  ) {
    return false;
  }

  cooldowns.set(
    key,
    now + duration
  );

  const timer =
    setTimeout(
      () => {
        if (
          cooldowns.get(
            key
          ) <=
          Date.now()
        ) {
          cooldowns.delete(
            key
          );
        }
      },
      duration + 250
    );

  if (
    typeof timer.unref ===
    'function'
  ) {
    timer.unref();
  }

  return true;
}


/* =========================================================
   P2 — TEMP NOTICE
   ========================================================= */

function buildNoticeText(
  text,
  type = 'info'
) {
  const icons = {
    success:
      '🟢',

    warning:
      '🟠',

    error:
      '🔴',

    info:
      '🔵'
  };

  return (
    `${icons[type] || icons.info} ` +
    String(text)
  );
}

function scheduleMessageDelete(
  message,
  delay =
    NOTICE_DELETE_MS
) {
  if (!message) {
    return;
  }

  const timer =
    setTimeout(
      async () => {
        try {
          await message.delete();
        } catch (_) {}
      },
      delay
    );

  if (
    typeof timer.unref ===
    'function'
  ) {
    timer.unref();
  }
}

function scheduleOriginalReplyDelete(
  interaction,
  delay =
    NOTICE_DELETE_MS
) {
  if (!interaction) {
    return;
  }

  const timer =
    setTimeout(
      async () => {
        try {
          await interaction.deleteReply();
        } catch (_) {}
      },
      delay
    );

  if (
    typeof timer.unref ===
    'function'
  ) {
    timer.unref();
  }
}

async function tempReply(
  interaction,
  text,
  type = 'info',
  delay =
    NOTICE_DELETE_MS
) {
  const payload = {
    content:
      buildNoticeText(
        text,
        type
      ),

    flags:
      MessageFlags.Ephemeral
  };

  try {
    if (
      interaction.deferred ||
      interaction.replied
    ) {
      const message =
        await interaction.followUp({
          ...payload,
          fetchReply:
            true
        });

      scheduleMessageDelete(
        message,
        delay
      );

      return message;
    }

    await interaction.reply(
      payload
    );

    scheduleOriginalReplyDelete(
      interaction,
      delay
    );

    return null;
  } catch (error) {
    logError(
      'TEMP_REPLY',
      error
    );

    return null;
  }
}

async function tempInteractionNotice(
  interaction,
  text,
  type = 'info',
  delay =
    NOTICE_DELETE_MS
) {
  return tempReply(
    interaction,
    text,
    type,
    delay
  );
}


/* =========================================================
   P2 — OWNER VALIDATION
   ========================================================= */

async function resolveInteractionManagedRoom(
  interaction
) {
  if (
    !interaction?.inGuild?.()
  ) {
    return null;
  }

  const channel =
    interaction.channel;

  if (
    !isVoiceChannel(
      channel
    )
  ) {
    return null;
  }

  const room =
    await getRoom(
      channel.id
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

  return {
    room,
    channel
  };
}

async function resolveOwnerInteractionRoom(
  interaction
) {
  const managed =
    await resolveInteractionManagedRoom(
      interaction
    );

  if (!managed) {
    await tempInteractionNotice(
      interaction,
      'Đây không phải phòng Voice HDK đang quản lý.',
      'warning'
    );

    return null;
  }

  if (
    String(
      managed.room.owner_id
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

  return managed;
}


/* =========================================================
   P2 — SELECTED TARGET RESOLUTION
   ========================================================= */

async function getSelectedTargetMember(
  interaction,
  room,
  channel,
  options = {}
) {
  const {
    requireSameRoom = false,
    allowOwner = false,
    allowBot = false
  } = options;

  const state =
    getSelectedMember(
      interaction.guildId,
      channel.id,
      interaction.user.id
    );

  if (!state) {
    await tempInteractionNotice(
      interaction,
      'Hãy chọn một thành viên trước.',
      'warning'
    );

    return null;
  }

  const member =
    await fetchMemberWithVoiceState(
      interaction.guild,
      state.memberId
    );

  if (!member) {
    clearSelectedMember(
      interaction.guildId,
      interaction.user.id
    );

    await tempInteractionNotice(
      interaction,
      'Thành viên đã chọn không còn trong Server.',
      'warning'
    );

    return null;
  }

  if (
    !allowBot &&
    member.user?.bot
  ) {
    clearSelectedMember(
      interaction.guildId,
      interaction.user.id
    );

    await tempInteractionNotice(
      interaction,
      'Không thể sử dụng chức năng này với Bot.',
      'warning'
    );

    return null;
  }

  if (
    !allowOwner &&
    String(
      member.id
    ) ===
      String(
        room.owner_id
      )
  ) {
    clearSelectedMember(
      interaction.guildId,
      interaction.user.id
    );

    await tempInteractionNotice(
      interaction,
      'Không thể chọn chính chủ phòng cho thao tác này.',
      'warning'
    );

    return null;
  }

  if (
    requireSameRoom
  ) {
    const actualChannelId =
      getMemberVoiceChannelId(
        member
      );

    if (
      actualChannelId !==
      String(
        channel.id
      )
    ) {
      clearSelectedMember(
        interaction.guildId,
        interaction.user.id
      );

      await tempInteractionNotice(
        interaction,
        `${member.displayName} không có mặt trong phòng này.`,
        'warning'
      );

      return null;
    }
  }

  return member;
}


/* =========================================================
   P2 — VOICE REGIONS
   ========================================================= */

function normalizeVoiceRegion(
  region
) {
  if (!region) {
    return null;
  }

  const id =
    String(
      region.id || ''
    ).trim();

  if (!id) {
    return null;
  }

  const name =
    String(
      region.name ||
      region.id
    )
      .replace(/\s+/g, ' ')
      .trim();

  return {
    id,
    name:
      name || id,

    optimal:
      Boolean(
        region.optimal
      ),

    deprecated:
      Boolean(
        region.deprecated
      ),

    custom:
      Boolean(
        region.custom
      )
  };
}

async function fetchVoiceRegions(
  force = false
) {
  const now =
    Date.now();

  if (
    !force &&
    regionCache.regions.length &&
    now -
      regionCache.fetchedAt <
      REGION_CACHE_MS
  ) {
    return regionCache.regions;
  }

  try {
    const fetched =
      await client.fetchVoiceRegions();

    const regions = [
      ...fetched.values()
    ]
      .map(
        normalizeVoiceRegion
      )
      .filter(Boolean)
      .filter(
        region =>
          !region.deprecated
      )
      .sort(
        (a, b) => {
          if (
            a.optimal !==
            b.optimal
          ) {
            return (
              a.optimal
                ? -1
                : 1
            );
          }

          return a.name.localeCompare(
            b.name,
            'vi'
          );
        }
      );

    regionCache = {
      fetchedAt:
        now,

      regions
    };

    return regions;
  } catch (error) {
    logError(
      'FETCH_VOICE_REGIONS',
      error
    );

    return (
      regionCache.regions ||
      []
    );
  }
}

async function resolveValidVoiceRegion(
  regionId
) {
  if (
    !regionId ||
    regionId ===
      'automatic'
  ) {
    return {
      valid:
        true,

      rtcRegion:
        null,

      region:
        null
    };
  }

  let regions =
    await fetchVoiceRegions(
      false
    );

  let region =
    regions.find(
      item =>
        item.id ===
        String(regionId)
    );

  /*
   * Có thể Discord vừa thay đổi region.
   * Refetch một lần trước khi kết luận invalid.
   */
  if (!region) {
    regions =
      await fetchVoiceRegions(
        true
      );

    region =
      regions.find(
        item =>
          item.id ===
          String(regionId)
      );
  }

  if (!region) {
    return {
      valid:
        false,

      rtcRegion:
        null,

      region:
        null
    };
  }

  return {
    valid:
      true,

    rtcRegion:
      region.id,

    region
  };
}


/* =========================================================
   P2 — ROOM STATE HELPERS
   ========================================================= */

function roomIsLocked(
  channel
) {
  if (
    !channel?.guild
  ) {
    return false;
  }

  const everyone =
    channel.permissionOverwrites.cache.get(
      channel.guild.roles.everyone.id
    );

  return (
    everyone?.deny?.has(
      PermissionsBitField.Flags.Connect
    ) ||
    false
  );
}

function roomIsHidden(
  channel
) {
  if (
    !channel?.guild
  ) {
    return false;
  }

  const everyone =
    channel.permissionOverwrites.cache.get(
      channel.guild.roles.everyone.id
    );

  return (
    everyone?.deny?.has(
      PermissionsBitField.Flags.ViewChannel
    ) ||
    false
  );
}

function roomRegionLabel(
  channel,
  regions = []
) {
  const rtcRegion =
    channel?.rtcRegion;

  if (!rtcRegion) {
    return 'Tự động';
  }

  const found =
    regions.find(
      region =>
        region.id ===
        rtcRegion
    );

  return (
    found?.name ||
    rtcRegion
  );
}


/* =========================================================
   P2 — ROOM BASE PERMISSIONS
   ========================================================= */

async function setRoomLocked(
  channel,
  locked
) {
  if (
    !channel?.guild
  ) {
    return false;
  }

  try {
    await channel.permissionOverwrites.edit(
      channel.guild.roles.everyone,
      {
        Connect:
          locked
            ? false
            : null
      },
      {
        reason:
          `${BOT_NAME} ${locked ? 'khóa' : 'mở'} phòng`
      }
    );

    return true;
  } catch (error) {
    logError(
      `ROOM_LOCK:${channel.id}`,
      error
    );

    return false;
  }
}

async function setRoomHidden(
  channel,
  hidden
) {
  if (
    !channel?.guild
  ) {
    return false;
  }

  try {
    await channel.permissionOverwrites.edit(
      channel.guild.roles.everyone,
      {
        ViewChannel:
          hidden
            ? false
            : null
      },
      {
        reason:
          `${BOT_NAME} ${hidden ? 'ẩn' : 'hiện'} phòng`
      }
    );

    return true;
  } catch (error) {
    logError(
      `ROOM_HIDE:${channel.id}`,
      error
    );

    return false;
  }
}


/* =========================================================
   P2 — RESET PERMISSIONS / SETTINGS
   ========================================================= */

async function resetManagedRoom(
  channel,
  room
) {
  if (
    !channel?.guild ||
    !room
  ) {
    return false;
  }

  try {
    /*
     * Mở + công khai.
     */
    await channel.permissionOverwrites.edit(
      channel.guild.roles.everyone,
      {
        ViewChannel:
          null,

        Connect:
          null
      },
      {
        reason:
          `${BOT_NAME} đặt lại phòng`
      }
    );

    /*
     * Xóa member-specific Invite / Deny / quyền cũ.
     * Giữ overwrite role.
     * Giữ owner bằng cách cấp lại sau đó.
     */
    await clearMemberSpecificOverwrites(
      channel,
      []
    );

    /*
     * Không giới hạn người.
     */
    if (
      channel.userLimit !==
      0
    ) {
      await channel.setUserLimit(
        0,
        `${BOT_NAME} đặt lại giới hạn`
      );
    }

    /*
     * Region tự động.
     */
    if (
      channel.rtcRegion !==
      null
    ) {
      await channel.setRTCRegion(
        null,
        `${BOT_NAME} đặt lại khu vực`
      );
    }

    /*
     * Reset DB ban.
     */
    await clearRoomBans(
      channel.id
    );

    /*
     * Chủ phòng luôn được cấp lại quyền cuối cùng.
     */
    await ensureOwnerDirectPermissions(
      channel,
      room.owner_id
    );

    return true;
  } catch (error) {
    logError(
      `RESET_ROOM:${channel.id}`,
      error
    );

    return false;
  }
}


/* =========================================================
   P2 — CROSS-ROOM SAFE KICK
   ========================================================= */

async function kickMemberFromExactRoom(
  guild,
  channel,
  memberId
) {
  /*
   * Fetch lại ngay trước disconnect.
   */
  const member =
    await resolveMemberInExactRoom(
      guild,
      memberId,
      channel.id
    );

  if (!member) {
    return {
      ok:
        false,

      reason:
        'NOT_IN_ROOM'
    };
  }

  /*
   * Revalidate thêm một lần sát action.
   */
  const current =
    await fetchMemberWithVoiceState(
      guild,
      member.id
    );

  if (
    !current ||
    getMemberVoiceChannelId(
      current
    ) !==
      String(
        channel.id
      )
  ) {
    return {
      ok:
        false,

      reason:
        'NOT_IN_ROOM'
    };
  }

  const disconnected =
    await safeDisconnectMember(
      current,
      `${BOT_NAME} đuổi khỏi phòng`
    );

  return {
    ok:
      disconnected,

    reason:
      disconnected
        ? null
        : 'FAILED',

    member:
      current
  };
}


/* =========================================================
   P2 — CROSS-ROOM SAFE DENY
   ========================================================= */

async function banMemberFromExactRoom(
  guild,
  channel,
  room,
  memberId,
  bannedBy
) {
  /*
   * Cấm chỉ được thực hiện khi target
   * đang thật sự ở đúng phòng.
   */
  let member =
    await resolveMemberInExactRoom(
      guild,
      memberId,
      channel.id
    );

  if (!member) {
    return {
      ok:
        false,

      reason:
        'NOT_IN_ROOM'
    };
  }

  /*
   * Revalidate ngay trước khi ghi permission.
   * Nếu target vừa sang phòng khác thì dừng.
   */
  member =
    await fetchMemberWithVoiceState(
      guild,
      member.id
    );

  if (
    !member ||
    getMemberVoiceChannelId(
      member
    ) !==
      String(
        channel.id
      )
  ) {
    return {
      ok:
        false,

      reason:
        'NOT_IN_ROOM'
    };
  }

  /*
   * Disconnect trước.
   *
   * Sau disconnect target không còn ở room,
   * nhưng chúng ta đã xác minh exact-room ngay
   * trước action. Permission deny chỉ áp dụng
   * lên chính room này.
   */
  const disconnected =
    await safeDisconnectMember(
      member,
      `${BOT_NAME} cấm khỏi phòng`
    );

  if (!disconnected) {
    return {
      ok:
        false,

      reason:
        'DISCONNECT_FAILED'
    };
  }

  const denied =
    await denyMemberPermissions(
      channel,
      member
    );

  if (!denied) {
    /*
     * Không ghi DB ban nếu permission Discord
     * không áp dụng thành công.
     */
    return {
      ok:
        false,

      reason:
        'PERMISSION_FAILED'
    };
  }

  try {
    await addRoomBan(
      guild.id,
      channel.id,
      member.id,
      bannedBy
    );
  } catch (error) {
    logError(
      `ADD_ROOM_BAN:${channel.id}:${member.id}`,
      error
    );

    /*
     * DB thất bại thì rollback overwrite
     * để Discord và DB không lệch nhau.
     */
    await removeMemberRoomOverride(
      channel,
      member
    ).catch(
      () => {}
    );

    return {
      ok:
        false,

      reason:
        'DATABASE_FAILED'
    };
  }

  return {
    ok:
      true,

    member
  };
}


/* =========================================================
   P2 — SAFE UNBAN
   ========================================================= */

async function unbanMemberFromRoom(
  guild,
  channel,
  memberId
) {
  /*
   * Bỏ cấm KHÔNG yêu cầu target ở trong room.
   */
  const member =
    await fetchMemberSafe(
      guild,
      memberId
    );

  if (!member) {
    return {
      ok:
        false,

      reason:
        'MEMBER_NOT_FOUND'
    };
  }

  const banned =
    await isRoomBanned(
      channel.id,
      member.id
    );

  if (!banned) {
    return {
      ok:
        false,

      reason:
        'NOT_BANNED',

      member
    };
  }

  const removed =
    await removeMemberRoomOverride(
      channel,
      member
    );

  if (!removed) {
    return {
      ok:
        false,

      reason:
        'PERMISSION_FAILED',

      member
    };
  }

  try {
    await removeRoomBan(
      channel.id,
      member.id
    );
  } catch (error) {
    logError(
      `REMOVE_ROOM_BAN:${channel.id}:${member.id}`,
      error
    );

    /*
     * DB chưa xóa được thì trả lỗi.
     * P7 startup/reconcile vẫn có thể xử lý lại.
     */
    return {
      ok:
        false,

      reason:
        'DATABASE_FAILED',

      member
    };
  }

  return {
    ok:
      true,

    member
  };
}


/* =========================================================
   P2 — INVITE SAFETY
   ========================================================= */

async function inviteMemberToRoom(
  guild,
  channel,
  memberId
) {
  /*
   * Invite là ngoại lệ:
   * target có thể đang ngoài room hoặc ngoài voice.
   * Tuyệt đối không move target.
   */
  const member =
    await fetchMemberSafe(
      guild,
      memberId
    );

  if (!member) {
    return {
      ok:
        false,

      reason:
        'MEMBER_NOT_FOUND'
    };
  }

  if (
    member.user?.bot
  ) {
    return {
      ok:
        false,

      reason:
        'BOT'
    };
  }

  const banned =
    await isRoomBanned(
      channel.id,
      member.id
    );

  if (banned) {
    return {
      ok:
        false,

      reason:
        'BANNED',

      member
    };
  }

  const granted =
    await grantInvitedMemberPermissions(
      channel,
      member
    );

  return {
    ok:
      granted,

    reason:
      granted
        ? null
        : 'PERMISSION_FAILED',

    member
  };
}


/* =========================================================
   P2 — TRANSFER REQUEST VALIDATION
   ========================================================= */

async function validateTransferTarget(
  guild,
  channel,
  room,
  memberId
) {
  const member =
    await resolveMemberInExactRoom(
      guild,
      memberId,
      channel.id
    );

  if (!member) {
    return {
      ok:
        false,

      reason:
        'NOT_IN_ROOM'
    };
  }

  if (
    member.user?.bot
  ) {
    return {
      ok:
        false,

      reason:
        'BOT'
    };
  }

  if (
    String(
      member.id
    ) ===
      String(
        room.owner_id
      )
  ) {
    return {
      ok:
        false,

      reason:
        'OWNER'
    };
  }

  const owned =
    await getOwnedRoom(
      guild.id,
      member.id
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
    return {
      ok:
        false,

      reason:
        'OWNS_OTHER_ROOM',

      member
    };
  }

  return {
    ok:
      true,

    member
  };
}


/* =========================================================
   P2 — REGION CHANGE
   ========================================================= */

async function changeRoomRegion(
  channel,
  regionId
) {
  const resolved =
    await resolveValidVoiceRegion(
      regionId
    );

  if (!resolved.valid) {
    return {
      ok:
        false,

      reason:
        'INVALID_REGION'
    };
  }

  try {
    await channel.setRTCRegion(
      resolved.rtcRegion,
      `${BOT_NAME} đổi khu vực thoại`
    );
  } catch (error) {
    logError(
      `SET_REGION:${channel.id}`,
      error
    );

    return {
      ok:
        false,

      reason:
        'DISCORD_FAILED'
    };
  }

  /*
   * Verify lại sau khi Discord nhận request.
   */
  let refreshed =
    null;

  try {
    refreshed =
      await channel.guild.channels.fetch(
        channel.id,
        {
          force:
            true
        }
      );
  } catch (_) {
    refreshed =
      channel;
  }

  const expected =
    resolved.rtcRegion ||
    null;

  const actual =
    refreshed?.rtcRegion ||
    null;

  if (
    actual !==
    expected
  ) {
    return {
      ok:
        false,

      reason:
        'VERIFY_FAILED'
    };
  }

  return {
    ok:
      true,

    region:
      resolved.region,

    rtcRegion:
      expected
  };
}


/* =========================================================
   P2 — SAFE ROOM DELETE DATABASE ORDER
   ========================================================= */

async function deleteManagedRoomDiscordFirst(
  guild,
  channelId,
  reason =
    `${BOT_NAME} xóa phòng trống`
) {
  const id =
    String(channelId);

  const room =
    await getRoom(
      id
    );

  if (!room) {
    clearRoomRuntimeState(
      id
    );

    return {
      ok:
        true,

      missing:
        true
    };
  }

  const channel =
    await fetchChannelSafe(
      guild,
      id
    );

  /*
   * Channel đã mất khỏi Discord:
   * DB stale có thể xóa an toàn.
   */
  if (!channel) {
    try {
      await deleteRoomRecord(
        id
      );

      clearRoomRuntimeState(
        id
      );

      return {
        ok:
          true,

        missing:
          true
      };
    } catch (error) {
      logError(
        `DELETE_STALE_ROOM:${id}`,
        error
      );

      return {
        ok:
          false,

        reason:
          'DATABASE_FAILED'
      };
    }
  }

  /*
   * QUAN TRỌNG:
   * Discord channel phải xóa thành công trước.
   */
  const deleted =
    await safeDeleteChannel(
      channel,
      reason
    );

  if (!deleted) {
    return {
      ok:
        false,

      reason:
        'CHANNEL_DELETE_FAILED'
    };
  }

  try {
    await deleteRoomRecord(
      id
    );

    clearRoomRuntimeState(
      id
    );

    return {
      ok:
        true,

      missing:
        false
    };
  } catch (error) {
    logError(
      `DELETE_ROOM_DB_AFTER_CHANNEL:${id}`,
      error
    );

    return {
      ok:
        false,

      reason:
        'DATABASE_FAILED'
    };
  }
}
/* =========================================================
   P3 — PANEL TEXT HELPERS
   ========================================================= */

const PANEL_LINE =
  '────────────────────────────';

const PANEL_TITLE_MAX =
  40;

const PANEL_FOOTER_MAX =
  40;

function compactText(
  value,
  maxLength = 40
) {
  const text =
    String(
      value || ''
    )
      .replace(/\s+/g, ' ')
      .trim();

  if (
    text.length <=
    maxLength
  ) {
    return text;
  }

  return (
    text.slice(
      0,
      Math.max(
        1,
        maxLength - 1
      )
    ) +
    '…'
  );
}

function panelOwnerName(
  member
) {
  if (!member) {
    return 'Chủ phòng';
  }

  return compactText(
    member.displayName ||
    member.user?.globalName ||
    member.user?.username ||
    'Chủ phòng',
    24
  );
}

function panelTitle(
  ownerMember
) {
  const name =
    panelOwnerName(
      ownerMember
    )
      .toLocaleUpperCase(
        'vi-VN'
      );

  return compactText(
    `🔊  PHÒNG CỦA ${name}`,
    PANEL_TITLE_MAX
  );
}

function panelFooterText(
  generator
) {
  const displayName =
    cleanDisplayName(
      generator?.display_name
    );

  if (!displayName) {
    return '✦ Voice HDK';
  }

  return compactText(
    `✦ Voice HDK • ${displayName}`,
    PANEL_FOOTER_MAX
  );
}

function roomMemberLimitLabel(
  channel
) {
  const limit =
    Number(
      channel?.userLimit ||
      0
    );

  return (
    limit > 0
      ? String(limit)
      : '∞'
  );
}

function roomHumanCount(
  channel
) {
  return humanMembers(
    channel
  ).length;
}


/* =========================================================
   P3 — SELECTED MEMBER PANEL STATE
   ========================================================= */

async function resolvePanelSelectedMember(
  guild,
  channel,
  viewerId
) {
  const state =
    getSelectedMember(
      guild.id,
      channel.id,
      viewerId
    );

  if (!state) {
    return {
      member:
        null,

      banned:
        false
    };
  }

  const member =
    await fetchMemberSafe(
      guild,
      state.memberId
    );

  if (!member) {
    clearSelectedMember(
      guild.id,
      viewerId
    );

    return {
      member:
        null,

      banned:
        false
    };
  }

  const banned =
    await isRoomBanned(
      channel.id,
      member.id
    ).catch(
      () => false
    );

  return {
    member,
    banned
  };
}


/* =========================================================
   P3 — PANEL EMBED
   ========================================================= */

async function buildRoomPanelEmbed(
  channel,
  room
) {
  const guild =
    channel.guild;

  const [
    owner,
    generator,
    regions
  ] =
    await Promise.all([
      fetchMemberSafe(
        guild,
        room.owner_id
      ),

      getGenerator(
        guild.id
      ),

      fetchVoiceRegions(
        false
      )
    ]);

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

  const memberCount =
    roomHumanCount(
      channel
    );

  const memberLimit =
    roomMemberLimitLabel(
      channel
    );

  const ownerMention =
    owner
      ? `<@${owner.id}>`
      : `<@${room.owner_id}>`;

  const description = [
    PANEL_LINE,

    `👑 Chủ phòng ${ownerMention}`,

    `👥 Thành viên ${memberCount} / ${memberLimit}`,

    `🔒 Phòng ${
      locked
        ? 'Đang khóa'
        : 'Đang mở'
    }`,

    `👁 Hiển thị ${
      hidden
        ? 'Đang ẩn'
        : 'Công khai'
    }`,

    `🌐 Khu vực ${compactText(
      region,
      25
    )}`,

    PANEL_LINE
  ].join('\n');

  return new EmbedBuilder()
    .setTitle(
      panelTitle(
        owner
      )
    )
    .setDescription(
      description
    )
    .setColor(
      UI_COLORS.blue
    )
    .setFooter({
      text:
        panelFooterText(
          generator
        )
    });
}


/* =========================================================
   P3 — ROW 1
   KHÓA / ẨN / ĐỔI TÊN
   ========================================================= */

function buildRoomPanelRow1(
  channel
) {
  const locked =
    roomIsLocked(
      channel
    );

  const hidden =
    roomIsHidden(
      channel
    );

  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          'voice_room_lock'
        )
        .setLabel(
          locked
            ? 'Mở'
            : 'Khóa'
        )
        .setEmoji(
          locked
            ? '🔓'
            : '🔒'
        )
        .setStyle(
          locked
            ? ButtonStyle.Success
            : ButtonStyle.Secondary
        ),

      new ButtonBuilder()
        .setCustomId(
          'voice_room_hide'
        )
        .setLabel(
          hidden
            ? 'Hiện'
            : 'Ẩn'
        )
        .setEmoji(
          hidden
            ? '👁️'
            : '🙈'
        )
        .setStyle(
          hidden
            ? ButtonStyle.Success
            : ButtonStyle.Secondary
        ),

      new ButtonBuilder()
        .setCustomId(
          'voice_room_rename'
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
}


/* =========================================================
   P3 — ROW 2
   ĐẶT LẠI / GIỚI HẠN / MỜI
   ========================================================= */

function buildRoomPanelRow2() {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          'voice_room_reset'
        )
        .setLabel(
          'Đặt lại'
        )
        .setEmoji(
          '🔄'
        )
        .setStyle(
          ButtonStyle.Secondary
        ),

      new ButtonBuilder()
        .setCustomId(
          'voice_room_limit'
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
          'voice_room_invite'
        )
        .setLabel(
          'Mời'
        )
        .setEmoji(
          '➕'
        )
        .setStyle(
          ButtonStyle.Success
        )
    );
}


/* =========================================================
   P3 — ROW 3
   CHUYỂN CHỦ / CẤM-BỎ CẤM / ĐUỔI
   ========================================================= */

function buildRoomPanelRow3(
  selectedState
) {
  const banned =
    Boolean(
      selectedState?.banned
    );

  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          'voice_room_transfer'
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
          'voice_room_ban'
        )
        .setLabel(
          banned
            ? 'Bỏ cấm'
            : 'Cấm'
        )
        .setEmoji(
          banned
            ? '✅'
            : '⛔'
        )
        .setStyle(
          banned
            ? ButtonStyle.Success
            : ButtonStyle.Danger
        ),

      new ButtonBuilder()
        .setCustomId(
          'voice_room_kick'
        )
        .setLabel(
          'Đuổi'
        )
        .setEmoji(
          '🚪'
        )
        .setStyle(
          ButtonStyle.Danger
        )
    );
}


/* =========================================================
   P3 — ROW 4
   USER SELECT
   ========================================================= */

function buildRoomPanelUserSelect(
  selectedState
) {
  let placeholder =
    'Chọn thành viên';

  if (
    selectedState?.member
  ) {
    placeholder =
      `Đã chọn: ${
        compactText(
          selectedState.member.displayName ||
          selectedState.member.user?.username ||
          'Thành viên',
          30
        )
      }`;
  }

  return new ActionRowBuilder()
    .addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(
          'voice_room_member_select'
        )
        .setPlaceholder(
          placeholder
        )
        .setMinValues(
          1
        )
        .setMaxValues(
          1
        )
    );
}


/* =========================================================
   P3 — ROW 5
   REGION SELECT
   ========================================================= */

async function buildRoomPanelRegionSelect(
  channel
) {
  const regions =
    await fetchVoiceRegions(
      false
    );

  const options = [];

  options.push({
    label:
      'Tự động',

    value:
      'automatic',

    description:
      'Discord tự chọn khu vực phù hợp',

    emoji:
      '🌐',

    default:
      !channel.rtcRegion
  });

  /*
   * Discord StringSelect tối đa 25 options.
   * Một option dành cho Automatic.
   */
  for (
    const region
    of regions.slice(
      0,
      24
    )
  ) {
    options.push({
      label:
        compactText(
          region.name,
          100
        ),

      value:
        region.id,

      description:
        region.optimal
          ? 'Khu vực đề xuất'
          : 'Khu vực thoại',

      default:
        channel.rtcRegion ===
        region.id
    });
  }

  return new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(
          'voice_room_region_select'
        )
        .setPlaceholder(
          'Chọn khu vực'
        )
        .setMinValues(
          1
        )
        .setMaxValues(
          1
        )
        .addOptions(
          options
        )
    );
}


/* =========================================================
   P3 — BUILD EXACTLY 5 ACTION ROWS
   ========================================================= */

async function buildRoomPanelComponents(
  channel,
  room,
  viewerId = null
) {
  /*
   * Panel là công khai.
   *
   * selectedMembers lại là state riêng
   * của người đang thao tác.
   *
   * Khi refresh do chính owner thao tác,
   * viewerId = owner ID để nút Cấm/Bỏ cấm
   * phản ánh target đã chọn.
   */

  const selectedState =
    viewerId
      ? await resolvePanelSelectedMember(
          channel.guild,
          channel,
          viewerId
        )
      : {
          member:
            null,

          banned:
            false
        };

  const regionRow =
    await buildRoomPanelRegionSelect(
      channel
    );

  return [
    buildRoomPanelRow1(
      channel
    ),

    buildRoomPanelRow2(),

    buildRoomPanelRow3(
      selectedState
    ),

    buildRoomPanelUserSelect(
      selectedState
    ),

    regionRow
  ];
}


/* =========================================================
   P3 — FIND PANEL MESSAGE
   ========================================================= */

async function fetchRoomControlMessage(
  channel,
  room
) {
  if (
    !channel ||
    !room?.control_message_id
  ) {
    return null;
  }

  try {
    return await channel.messages.fetch(
      String(
        room.control_message_id
      )
    );
  } catch (_) {
    return null;
  }
}


/* =========================================================
   P3 — REMOVE DUPLICATE BOT PANELS
   ========================================================= */

async function removeDuplicateRoomPanels(
  channel,
  keepMessageId
) {
  if (
    !channel?.messages ||
    !client.user
  ) {
    return;
  }

  let messages;

  try {
    messages =
      await channel.messages.fetch({
        limit:
          50
      });
  } catch (_) {
    return;
  }

  for (
    const message
    of messages.values()
  ) {
    if (
      message.author?.id !==
      client.user.id
    ) {
      continue;
    }

    if (
      keepMessageId &&
      message.id ===
      String(
        keepMessageId
      )
    ) {
      continue;
    }

    /*
     * Chỉ xóa message nhìn giống control panel.
     * Không đụng notice transfer/absence/log khác.
     */
    const hasPanelComponent =
      message.components?.some(
        row =>
          row.components?.some(
            component =>
              [
                'voice_room_lock',
                'voice_room_member_select',
                'voice_room_region_select'
              ].includes(
                component.customId
              )
          )
      );

    if (
      !hasPanelComponent
    ) {
      continue;
    }

    try {
      await message.delete();
    } catch (_) {}
  }
}


/* =========================================================
   P3 — CREATE / REPAIR PANEL
   ========================================================= */

async function ensureRoomPanel(
  channel,
  room,
  viewerId = null
) {
  if (
    !channel ||
    !room
  ) {
    return null;
  }

  const channelId =
    String(
      channel.id
    );

  /*
   * Chống 2 event đồng thời tạo 2 panel.
   */
  if (
    panelLocks.has(
      channelId
    )
  ) {
    return panelLocks.get(
      channelId
    );
  }

  const task =
    (async () => {
      let currentRoom =
        await getRoom(
          channelId
        );

      if (!currentRoom) {
        return null;
      }

      let message =
        await fetchRoomControlMessage(
          channel,
          currentRoom
        );

      const embed =
        await buildRoomPanelEmbed(
          channel,
          currentRoom
        );

      const components =
        await buildRoomPanelComponents(
          channel,
          currentRoom,
          viewerId
        );

      /*
       * Panel cũ còn tồn tại:
       * edit đúng message đó.
       */
      if (message) {
        try {
          await message.edit({
            content:
              null,

            embeds: [
              embed
            ],

            components
          });

          await removeDuplicateRoomPanels(
            channel,
            message.id
          );

          return message;
        } catch (error) {
          logError(
            `EDIT_PANEL:${channelId}`,
            error
          );

          message =
            null;
        }
      }

      /*
       * control_message_id stale hoặc chưa có:
       * tạo panel mới.
       */
      try {
        message =
          await channel.send({
            embeds: [
              embed
            ],

            components
          });
      } catch (error) {
        logError(
          `CREATE_PANEL:${channelId}`,
          error
        );

        return null;
      }

      try {
        currentRoom =
          await updateRoomControlMessage(
            channelId,
            message.id
          ) ||
          currentRoom;
      } catch (error) {
        logError(
          `SAVE_PANEL_ID:${channelId}`,
          error
        );
      }

      await removeDuplicateRoomPanels(
        channel,
        message.id
      );

      return message;
    })();

  panelLocks.set(
    channelId,
    task
  );

  try {
    return await task;
  } finally {
    if (
      panelLocks.get(
        channelId
      ) === task
    ) {
      panelLocks.delete(
        channelId
      );
    }
  }
}


/* =========================================================
   P3 — REFRESH PANEL
   ========================================================= */

async function refreshRoomPanel(
  channel,
  viewerId = null
) {
  if (!channel) {
    return null;
  }

  const room =
    await getRoom(
      channel.id
    );

  if (!room) {
    return null;
  }

  return ensureRoomPanel(
    channel,
    room,
    viewerId
  );
}


/* =========================================================
   P3 — REFRESH + CLEAR SELECTED TARGET
   ========================================================= */

async function clearSelectionAndRefreshPanel(
  interaction,
  channel
) {
  if (
    interaction?.guildId &&
    interaction?.user?.id
  ) {
    clearSelectedMember(
      interaction.guildId,
      interaction.user.id
    );
  }

  return refreshRoomPanel(
    channel,
    interaction?.user?.id ||
    null
  );
}


/* =========================================================
   P3 — RENAME MODAL
   ========================================================= */

function buildRenameRoomModal(
  channel
) {
  const modal =
    new ModalBuilder()
      .setCustomId(
        'voice_room_rename_modal'
      )
      .setTitle(
        'Đổi tên phòng'
      );

  const input =
    new TextInputBuilder()
      .setCustomId(
        'voice_room_rename_input'
      )
      .setLabel(
        'Tên phòng mới'
      )
      .setStyle(
        TextInputStyle.Short
      )
      .setRequired(
        true
      )
      .setMinLength(
        1
      )
      .setMaxLength(
        80
      );

  const currentName =
    String(
      channel?.name ||
      ''
    )
      .replace(
        /^🔊・/,
        ''
      )
      .trim();

  if (currentName) {
    input.setValue(
      currentName.slice(
        0,
        80
      )
    );
  }

  modal.addComponents(
    new ActionRowBuilder()
      .addComponents(
        input
      )
  );

  return modal;
}


/* =========================================================
   P3 — USER LIMIT MODAL
   ========================================================= */

function buildRoomLimitModal(
  channel
) {
  const modal =
    new ModalBuilder()
      .setCustomId(
        'voice_room_limit_modal'
      )
      .setTitle(
        'Giới hạn thành viên'
      );

  const input =
    new TextInputBuilder()
      .setCustomId(
        'voice_room_limit_input'
      )
      .setLabel(
        'Số người tối đa • 0 = Không giới hạn'
      )
      .setStyle(
        TextInputStyle.Short
      )
      .setRequired(
        true
      )
      .setMinLength(
        1
      )
      .setMaxLength(
        2
      )
      .setValue(
        String(
          channel?.userLimit ||
          0
        )
      );

  modal.addComponents(
    new ActionRowBuilder()
      .addComponents(
        input
      )
  );

  return modal;
}


/* =========================================================
   P3 — PANEL INTERACTION OWNER GUARD
   ========================================================= */

async function getPanelOwnerContext(
  interaction
) {
  if (
    !interaction.inGuild()
  ) {
    await tempInteractionNotice(
      interaction,
      'Chức năng này chỉ sử dụng trong Server.',
      'warning'
    );

    return null;
  }

  const channel =
    interaction.channel;

  if (
    !isVoiceChannel(
      channel
    )
  ) {
    await tempInteractionNotice(
      interaction,
      'Panel này không còn thuộc phòng thoại hợp lệ.',
      'warning'
    );

    return null;
  }

  const room =
    await getRoom(
      channel.id
    );

  if (!room) {
    await tempInteractionNotice(
      interaction,
      'Phòng này không còn được Voice HDK quản lý.',
      'warning'
    );

    return null;
  }

  if (
    String(
      room.guild_id
    ) !==
      String(
        interaction.guildId
      )
  ) {
    await tempInteractionNotice(
      interaction,
      'Dữ liệu phòng không hợp lệ.',
      'error'
    );

    return null;
  }

  /*
   * Panel ai trong phòng cũng nhìn thấy.
   * Nhưng mọi control chỉ owner được dùng.
   */
  if (
    String(
      room.owner_id
    ) !==
      String(
        interaction.user.id
      )
  ) {
    await tempInteractionNotice(
      interaction,
      'Chỉ chủ phòng mới có thể sử dụng bảng điều khiển.',
      'warning'
    );

    return null;
  }

  return {
    room,
    channel
  };
}


/* =========================================================
   P3 — SELECT MEMBER UI HANDLER
   ========================================================= */

async function handleRoomMemberSelect(
  interaction
) {
  const context =
    await getPanelOwnerContext(
      interaction
    );

  if (!context) {
    return;
  }

  const {
    room,
    channel
  } = context;

  const memberId =
    interaction.values?.[0];

  if (
    !memberId ||
    !isSnowflake(
      String(
        memberId
      )
    )
  ) {
    clearSelectedMember(
      interaction.guildId,
      interaction.user.id
    );

    await interaction.deferUpdate()
      .catch(
        () => {}
      );

    await refreshRoomPanel(
      channel,
      interaction.user.id
    );

    return tempInteractionNotice(
      interaction,
      'Thành viên đã chọn không hợp lệ.',
      'warning'
    );
  }

  const member =
    await fetchMemberSafe(
      interaction.guild,
      memberId
    );

  if (!member) {
    clearSelectedMember(
      interaction.guildId,
      interaction.user.id
    );

    await interaction.deferUpdate()
      .catch(
        () => {}
      );

    await refreshRoomPanel(
      channel,
      interaction.user.id
    );

    return tempInteractionNotice(
      interaction,
      'Không tìm thấy thành viên này.',
      'warning'
    );
  }

  if (
    member.user?.bot
  ) {
    clearSelectedMember(
      interaction.guildId,
      interaction.user.id
    );

    await interaction.deferUpdate()
      .catch(
        () => {}
      );

    await refreshRoomPanel(
      channel,
      interaction.user.id
    );

    return tempInteractionNotice(
      interaction,
      'Không thể chọn Bot.',
      'warning'
    );
  }

  if (
    String(
      member.id
    ) ===
      String(
        room.owner_id
      )
  ) {
    clearSelectedMember(
      interaction.guildId,
      interaction.user.id
    );

    await interaction.deferUpdate()
      .catch(
        () => {}
      );

    await refreshRoomPanel(
      channel,
      interaction.user.id
    );

    return tempInteractionNotice(
      interaction,
      'Bạn đang là chủ phòng.',
      'warning'
    );
  }

  setSelectedMember(
    interaction.guildId,
    channel.id,
    interaction.user.id,
    member.id
  );

  await interaction.deferUpdate();

  /*
   * Refresh để nút Cấm đổi thành Bỏ cấm
   * nếu target đang nằm trong room_bans.
   */
  await refreshRoomPanel(
    channel,
    interaction.user.id
  );
}


/* =========================================================
   P3 — REGION SELECT UI HANDLER
   ========================================================= */

async function handleRoomRegionSelect(
  interaction
) {
  const context =
    await getPanelOwnerContext(
      interaction
    );

  if (!context) {
    return;
  }

  const {
    channel
  } = context;

  if (
    !takeCooldown(
      interaction.guildId,
      interaction.user.id,
      'region'
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
      'Khu vực đã chọn không hợp lệ.',
      'warning'
    );
  }

  await interaction.deferUpdate();

  const result =
    await changeRoomRegion(
      channel,
      regionId
    );

  if (!result.ok) {
    await refreshRoomPanel(
      channel,
      interaction.user.id
    );

    if (
      result.reason ===
      'INVALID_REGION'
    ) {
      return tempInteractionNotice(
        interaction,
        'Khu vực này không còn khả dụng. Danh sách đã được làm mới.',
        'warning'
      );
    }

    return tempInteractionNotice(
      interaction,
      'Không thể đổi khu vực thoại.',
      'error'
    );
  }

  await refreshRoomPanel(
    channel,
    interaction.user.id
  );

  const label =
    result.rtcRegion
      ? (
          result.region?.name ||
          result.rtcRegion
        )
      : 'Tự động';

  await tempInteractionNotice(
    interaction,
    `Đã đổi khu vực thành ${label}.`,
    'success'
  );
}


/* =========================================================
   P3 — PANEL ID RECOGNITION
   ========================================================= */

const ROOM_PANEL_BUTTON_IDS =
  new Set([
    'voice_room_lock',
    'voice_room_hide',
    'voice_room_rename',

    'voice_room_reset',
    'voice_room_limit',
    'voice_room_invite',

    'voice_room_transfer',
    'voice_room_ban',
    'voice_room_kick'
  ]);

const ROOM_PANEL_SELECT_IDS =
  new Set([
    'voice_room_member_select',
    'voice_room_region_select'
  ]);

const ROOM_PANEL_MODAL_IDS =
  new Set([
    'voice_room_rename_modal',
    'voice_room_limit_modal'
  ]);

function isRoomPanelButtonId(
  customId
) {
  return ROOM_PANEL_BUTTON_IDS.has(
    String(
      customId || ''
    )
  );
}

function isRoomPanelSelectId(
  customId
) {
  return ROOM_PANEL_SELECT_IDS.has(
    String(
      customId || ''
    )
  );
}

function isRoomPanelModalId(
  customId
) {
  return ROOM_PANEL_MODAL_IDS.has(
    String(
      customId || ''
    )
  );
}
/* =========================================================
   P4 — ACTION LOG HELPER
   ========================================================= */

async function sendActionLog(
  guild,
  text
) {
  if (!guild) {
    return;
  }

  const generator =
    await getGenerator(
      guild.id
    ).catch(
      () => null
    );

  if (
    !generator?.action_log_channel_id
  ) {
    return;
  }

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
    return;
  }

  try {
    await channel.send({
      content:
        truncateLogText(
          `[${vietnamTime()}] ${text}`,
          1900
        )
    });
  } catch (error) {
    logError(
      `ACTION_LOG:${guild.id}`,
      error
    );
  }
}


/* =========================================================
   P4 — LOCK
   ========================================================= */

async function handleRoomLockButton(
  interaction
) {
  const context =
    await getPanelOwnerContext(
      interaction
    );

  if (!context) {
    return;
  }

  const {
    channel
  } = context;

  if (
    !takeCooldown(
      interaction.guildId,
      interaction.user.id,
      'lock'
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn thao tác quá nhanh.',
      'warning'
    );
  }

  await interaction.deferUpdate();

  const nextLocked =
    !roomIsLocked(
      channel
    );

  const ok =
    await setRoomLocked(
      channel,
      nextLocked
    );

  if (!ok) {
    await refreshRoomPanel(
      channel,
      interaction.user.id
    );

    return tempInteractionNotice(
      interaction,
      'Không thể thay đổi trạng thái khóa phòng.',
      'error'
    );
  }

  await refreshRoomPanel(
    channel,
    interaction.user.id
  );

  await sendActionLog(
    interaction.guild,
    `${interaction.user.tag} ${nextLocked ? 'khóa' : 'mở'} phòng ${channel.name}.`
  );
}


/* =========================================================
   P4 — HIDE
   ========================================================= */

async function handleRoomHideButton(
  interaction
) {
  const context =
    await getPanelOwnerContext(
      interaction
    );

  if (!context) {
    return;
  }

  const {
    channel
  } = context;

  if (
    !takeCooldown(
      interaction.guildId,
      interaction.user.id,
      'hide'
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn thao tác quá nhanh.',
      'warning'
    );
  }

  await interaction.deferUpdate();

  const nextHidden =
    !roomIsHidden(
      channel
    );

  const ok =
    await setRoomHidden(
      channel,
      nextHidden
    );

  if (!ok) {
    await refreshRoomPanel(
      channel,
      interaction.user.id
    );

    return tempInteractionNotice(
      interaction,
      'Không thể thay đổi trạng thái hiển thị của phòng.',
      'error'
    );
  }

  await refreshRoomPanel(
    channel,
    interaction.user.id
  );

  await sendActionLog(
    interaction.guild,
    `${interaction.user.tag} ${nextHidden ? 'ẩn' : 'hiện'} phòng ${channel.name}.`
  );
}


/* =========================================================
   P4 — RENAME BUTTON
   ========================================================= */

async function handleRoomRenameButton(
  interaction
) {
  const context =
    await getPanelOwnerContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    !takeCooldown(
      interaction.guildId,
      interaction.user.id,
      'rename_button'
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn thao tác quá nhanh.',
      'warning'
    );
  }

  try {
    await interaction.showModal(
      buildRenameRoomModal(
        context.channel
      )
    );
  } catch (error) {
    logError(
      'SHOW_RENAME_MODAL',
      error
    );
  }
}


/* =========================================================
   P4 — RENAME MODAL
   ========================================================= */

async function handleRoomRenameModal(
  interaction
) {
  const context =
    await getPanelOwnerContext(
      interaction
    );

  if (!context) {
    return;
  }

  const {
    channel
  } = context;

  const rawName =
    interaction.fields.getTextInputValue(
      'voice_room_rename_input'
    );

  let name =
    String(
      rawName || ''
    )
      .replace(/\s+/g, ' ')
      .trim();

  /*
   * Không cho user tự nhét prefix nhiều lần.
   */
  name =
    name.replace(
      /^🔊[・\-\s]*/u,
      ''
    ).trim();

  if (!name) {
    return tempReply(
      interaction,
      'Tên phòng không hợp lệ.',
      'warning'
    );
  }

  name =
    name.slice(
      0,
      80
    );

  const finalName =
    `${ROOM_PREFIX}${name}`;

  await interaction.deferReply({
    flags:
      MessageFlags.Ephemeral
  });

  try {
    await channel.setName(
      finalName,
      `${BOT_NAME} đổi tên phòng`
    );
  } catch (error) {
    logError(
      `RENAME_ROOM:${channel.id}`,
      error
    );

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

  await refreshRoomPanel(
    channel,
    interaction.user.id
  );

  await sendActionLog(
    interaction.guild,
    `${interaction.user.tag} đổi tên phòng thành ${finalName}.`
  );

  await interaction.editReply({
    content:
      buildNoticeText(
        `Đã đổi tên thành ${finalName}.`,
        'success'
      )
  });

  scheduleOriginalReplyDelete(
    interaction
  );
}


/* =========================================================
   P4 — LIMIT BUTTON
   ========================================================= */

async function handleRoomLimitButton(
  interaction
) {
  const context =
    await getPanelOwnerContext(
      interaction
    );

  if (!context) {
    return;
  }

  if (
    !takeCooldown(
      interaction.guildId,
      interaction.user.id,
      'limit_button'
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn thao tác quá nhanh.',
      'warning'
    );
  }

  try {
    await interaction.showModal(
      buildRoomLimitModal(
        context.channel
      )
    );
  } catch (error) {
    logError(
      'SHOW_LIMIT_MODAL',
      error
    );
  }
}


/* =========================================================
   P4 — LIMIT MODAL
   ========================================================= */

async function handleRoomLimitModal(
  interaction
) {
  const context =
    await getPanelOwnerContext(
      interaction
    );

  if (!context) {
    return;
  }

  const {
    channel
  } = context;

  const raw =
    interaction.fields.getTextInputValue(
      'voice_room_limit_input'
    ).trim();

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
      'Giới hạn phải từ 0 đến 99.',
      'warning'
    );
  }

  await interaction.deferReply({
    flags:
      MessageFlags.Ephemeral
  });

  try {
    await channel.setUserLimit(
      limit,
      `${BOT_NAME} đổi giới hạn phòng`
    );
  } catch (error) {
    logError(
      `ROOM_LIMIT:${channel.id}`,
      error
    );

    await interaction.editReply({
      content:
        buildNoticeText(
          'Không thể thay đổi giới hạn thành viên.',
          'error'
        )
    });

    scheduleOriginalReplyDelete(
      interaction
    );

    return;
  }

  await refreshRoomPanel(
    channel,
    interaction.user.id
  );

  const label =
    limit === 0
      ? 'Không giới hạn'
      : `${limit} người`;

  await sendActionLog(
    interaction.guild,
    `${interaction.user.tag} đặt giới hạn phòng ${channel.name}: ${label}.`
  );

  await interaction.editReply({
    content:
      buildNoticeText(
        `Giới hạn: ${label}.`,
        'success'
      )
  });

  scheduleOriginalReplyDelete(
    interaction
  );
}


/* =========================================================
   P4 — RESET
   ========================================================= */

async function handleRoomResetButton(
  interaction
) {
  const context =
    await getPanelOwnerContext(
      interaction
    );

  if (!context) {
    return;
  }

  const {
    room,
    channel
  } = context;

  if (
    !takeCooldown(
      interaction.guildId,
      interaction.user.id,
      'reset',
      3000
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn thao tác quá nhanh.',
      'warning'
    );
  }

  await interaction.deferUpdate();

  clearPendingTransfer(
    channel.id
  );

  const ok =
    await resetManagedRoom(
      channel,
      room
    );

  clearSelectedMember(
    interaction.guildId,
    interaction.user.id
  );

  await refreshRoomPanel(
    channel,
    interaction.user.id
  );

  if (!ok) {
    return tempInteractionNotice(
      interaction,
      'Không thể đặt lại toàn bộ phòng.',
      'error'
    );
  }

  await sendActionLog(
    interaction.guild,
    `${interaction.user.tag} đặt lại phòng ${channel.name}.`
  );

  await tempInteractionNotice(
    interaction,
    'Đã đặt lại phòng.',
    'success'
  );
}


/* =========================================================
   P4 — INVITE
   ========================================================= */

async function handleRoomInviteButton(
  interaction
) {
  const context =
    await getPanelOwnerContext(
      interaction
    );

  if (!context) {
    return;
  }

  const {
    room,
    channel
  } = context;

  if (
    !takeCooldown(
      interaction.guildId,
      interaction.user.id,
      'invite'
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn thao tác quá nhanh.',
      'warning'
    );
  }

  const target =
    await getSelectedTargetMember(
      interaction,
      room,
      channel,
      {
        requireSameRoom:
          false,

        allowOwner:
          false,

        allowBot:
          false
      }
    );

  if (!target) {
    await refreshRoomPanel(
      channel,
      interaction.user.id
    );

    return;
  }

  await interaction.deferUpdate();

  const result =
    await inviteMemberToRoom(
      interaction.guild,
      channel,
      target.id
    );

  /*
   * Sau action phải clear select.
   */
  clearSelectedMember(
    interaction.guildId,
    interaction.user.id
  );

  await refreshRoomPanel(
    channel,
    interaction.user.id
  );

  if (!result.ok) {
    let text =
      'Không thể mời thành viên này.';

    if (
      result.reason ===
      'BANNED'
    ) {
      text =
        'Thành viên này đang bị cấm khỏi phòng. Hãy bỏ cấm trước.';
    }

    if (
      result.reason ===
      'MEMBER_NOT_FOUND'
    ) {
      text =
        'Không còn tìm thấy thành viên này.';
    }

    return tempInteractionNotice(
      interaction,
      text,
      'warning'
    );
  }

  await sendActionLog(
    interaction.guild,
    `${interaction.user.tag} mời ${target.user.tag} vào ${channel.name}.`
  );

  await tempInteractionNotice(
    interaction,
    `Đã mời ${target.displayName}.`,
    'success'
  );
}


/* =========================================================
   P4 — KICK
   ========================================================= */

async function handleRoomKickButton(
  interaction
) {
  const context =
    await getPanelOwnerContext(
      interaction
    );

  if (!context) {
    return;
  }

  const {
    room,
    channel
  } = context;

  if (
    !takeCooldown(
      interaction.guildId,
      interaction.user.id,
      'kick'
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn thao tác quá nhanh.',
      'warning'
    );
  }

  const target =
    await getSelectedTargetMember(
      interaction,
      room,
      channel,
      {
        requireSameRoom:
          true,

        allowOwner:
          false,

        allowBot:
          false
      }
    );

  if (!target) {
    await refreshRoomPanel(
      channel,
      interaction.user.id
    );

    return;
  }

  await interaction.deferUpdate();

  /*
   * kickMemberFromExactRoom lại fetch/revalidate
   * lần nữa ngay trước disconnect.
   */
  const result =
    await kickMemberFromExactRoom(
      interaction.guild,
      channel,
      target.id
    );

  clearSelectedMember(
    interaction.guildId,
    interaction.user.id
  );

  await refreshRoomPanel(
    channel,
    interaction.user.id
  );

  if (!result.ok) {
    if (
      result.reason ===
      'NOT_IN_ROOM'
    ) {
      return tempInteractionNotice(
        interaction,
        `${target.displayName} không có mặt trong phòng này.`,
        'warning'
      );
    }

    return tempInteractionNotice(
      interaction,
      'Không thể đuổi thành viên.',
      'error'
    );
  }

  await sendActionLog(
    interaction.guild,
    `${interaction.user.tag} đuổi ${target.user.tag} khỏi ${channel.name}.`
  );

  await tempInteractionNotice(
    interaction,
    `Đã đuổi ${target.displayName}.`,
    'success'
  );
}


/* =========================================================
   P4 — BAN / UNBAN TOGGLE
   ========================================================= */

async function handleRoomBanButton(
  interaction
) {
  const context =
    await getPanelOwnerContext(
      interaction
    );

  if (!context) {
    return;
  }

  const {
    room,
    channel
  } = context;

  if (
    !takeCooldown(
      interaction.guildId,
      interaction.user.id,
      'ban'
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn thao tác quá nhanh.',
      'warning'
    );
  }

  const state =
    getSelectedMember(
      interaction.guildId,
      channel.id,
      interaction.user.id
    );

  if (!state) {
    return tempInteractionNotice(
      interaction,
      'Hãy chọn một thành viên trước.',
      'warning'
    );
  }

  const target =
    await fetchMemberSafe(
      interaction.guild,
      state.memberId
    );

  if (!target) {
    clearSelectedMember(
      interaction.guildId,
      interaction.user.id
    );

    await refreshRoomPanel(
      channel,
      interaction.user.id
    );

    return tempInteractionNotice(
      interaction,
      'Thành viên đã chọn không còn trong Server.',
      'warning'
    );
  }

  if (
    target.user?.bot ||
    String(
      target.id
    ) ===
      String(
        room.owner_id
      )
  ) {
    clearSelectedMember(
      interaction.guildId,
      interaction.user.id
    );

    await refreshRoomPanel(
      channel,
      interaction.user.id
    );

    return tempInteractionNotice(
      interaction,
      'Không thể thực hiện thao tác này với thành viên đã chọn.',
      'warning'
    );
  }

  const banned =
    await isRoomBanned(
      channel.id,
      target.id
    );

  await interaction.deferUpdate();

  /*
   * -----------------------------------------------------
   * UNBAN
   *
   * Không yêu cầu target ở room.
   * -----------------------------------------------------
   */
  if (banned) {
    const result =
      await unbanMemberFromRoom(
        interaction.guild,
        channel,
        target.id
      );

    clearSelectedMember(
      interaction.guildId,
      interaction.user.id
    );

    await refreshRoomPanel(
      channel,
      interaction.user.id
    );

    if (!result.ok) {
      return tempInteractionNotice(
        interaction,
        'Không thể bỏ cấm thành viên.',
        'error'
      );
    }

    await sendActionLog(
      interaction.guild,
      `${interaction.user.tag} bỏ cấm ${target.user.tag} khỏi ${channel.name}.`
    );

    return tempInteractionNotice(
      interaction,
      `Đã bỏ cấm ${target.displayName}.`,
      'success'
    );
  }

  /*
   * -----------------------------------------------------
   * BAN
   *
   * Target bắt buộc đang ở exact room.
   * -----------------------------------------------------
   */

  const result =
    await banMemberFromExactRoom(
      interaction.guild,
      channel,
      room,
      target.id,
      interaction.user.id
    );

  clearSelectedMember(
    interaction.guildId,
    interaction.user.id
  );

  await refreshRoomPanel(
    channel,
    interaction.user.id
  );

  if (!result.ok) {
    if (
      result.reason ===
      'NOT_IN_ROOM'
    ) {
      return tempInteractionNotice(
        interaction,
        `${target.displayName} không có mặt trong phòng này.`,
        'warning'
      );
    }

    return tempInteractionNotice(
      interaction,
      'Không thể cấm thành viên này.',
      'error'
    );
  }

  await sendActionLog(
    interaction.guild,
    `${interaction.user.tag} cấm ${target.user.tag} khỏi ${channel.name}.`
  );

  await tempInteractionNotice(
    interaction,
    `Đã cấm ${target.displayName}.`,
    'success'
  );
}


/* =========================================================
   P4 — TRANSFER MESSAGE UI
   ========================================================= */

function buildTransferComponents(
  channelId,
  ownerId,
  targetId
) {
  return [
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `voice_transfer_accept:${channelId}:${ownerId}:${targetId}`
          )
          .setLabel(
            'Đồng ý'
          )
          .setEmoji(
            '✅'
          )
          .setStyle(
            ButtonStyle.Success
          ),

        new ButtonBuilder()
          .setCustomId(
            `voice_transfer_decline:${channelId}:${ownerId}:${targetId}`
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
  ];
}


/* =========================================================
   P4 — TRANSFER REQUEST
   ========================================================= */

async function handleRoomTransferButton(
  interaction
) {
  const context =
    await getPanelOwnerContext(
      interaction
    );

  if (!context) {
    return;
  }

  const {
    room,
    channel
  } = context;

  if (
    !takeCooldown(
      interaction.guildId,
      interaction.user.id,
      'transfer'
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
      channel.id
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Phòng đang có một yêu cầu chuyển chủ chưa kết thúc.',
      'warning'
    );
  }

  const target =
    await getSelectedTargetMember(
      interaction,
      room,
      channel,
      {
        requireSameRoom:
          true,

        allowOwner:
          false,

        allowBot:
          false
      }
    );

  if (!target) {
    await refreshRoomPanel(
      channel,
      interaction.user.id
    );

    return;
  }

  /*
   * Validate ownership + exact room lần nữa.
   */
  const validation =
    await validateTransferTarget(
      interaction.guild,
      channel,
      room,
      target.id
    );

  if (!validation.ok) {
    clearSelectedMember(
      interaction.guildId,
      interaction.user.id
    );

    await refreshRoomPanel(
      channel,
      interaction.user.id
    );

    if (
      validation.reason ===
      'NOT_IN_ROOM'
    ) {
      return tempInteractionNotice(
        interaction,
        `${target.displayName} không có mặt trong phòng này.`,
        'warning'
      );
    }

    if (
      validation.reason ===
      'OWNS_OTHER_ROOM'
    ) {
      return tempInteractionNotice(
        interaction,
        `${target.displayName} đang sở hữu một phòng khác.`,
        'warning'
      );
    }

    return tempInteractionNotice(
      interaction,
      'Không thể chuyển chủ cho thành viên này.',
      'warning'
    );
  }

  await interaction.deferUpdate();

  let message;

  try {
    message =
      await channel.send({
        content: [
          `👑 <@${target.id}>`,
          `<@${interaction.user.id}> muốn chuyển quyền chủ phòng cho bạn.`,
          '',
          `Yêu cầu hết hạn <t:${Math.floor(
            (
              Date.now() +
              TRANSFER_TIMEOUT_MS
            ) / 1000
          )}:R>.`
        ].join('\n'),

        components:
          buildTransferComponents(
            channel.id,
            interaction.user.id,
            target.id
          )
      });
  } catch (error) {
    logError(
      `TRANSFER_REQUEST:${channel.id}`,
      error
    );

    clearSelectedMember(
      interaction.guildId,
      interaction.user.id
    );

    await refreshRoomPanel(
      channel,
      interaction.user.id
    );

    return tempInteractionNotice(
      interaction,
      'Không thể gửi yêu cầu chuyển chủ.',
      'error'
    );
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
        interaction.user.id
      ),

    targetId:
      String(
        target.id
      ),

    messageId:
      String(
        message.id
      ),

    expiresAt:
      Date.now() +
      TRANSFER_TIMEOUT_MS,

    timer:
      null
  };

  transfer.timer =
    setTimeout(
      async () => {
        const current =
          pendingTransfers.get(
            String(
              channel.id
            )
          );

        if (
          current !==
          transfer
        ) {
          return;
        }

        pendingTransfers.delete(
          String(
            channel.id
          )
        );

        try {
          const currentMessage =
            await channel.messages.fetch(
              transfer.messageId
            );

          await currentMessage.edit({
            content:
              '🟠 Yêu cầu chuyển chủ đã hết hạn.',

            components:
              []
          });

          scheduleMessageDelete(
            currentMessage
          );
        } catch (_) {}
      },
      TRANSFER_TIMEOUT_MS
    );

  if (
    typeof transfer.timer.unref ===
    'function'
  ) {
    transfer.timer.unref();
  }

  pendingTransfers.set(
    String(
      channel.id
    ),
    transfer
  );

  clearSelectedMember(
    interaction.guildId,
    interaction.user.id
  );

  await refreshRoomPanel(
    channel,
    interaction.user.id
  );
}


/* =========================================================
   P4 — PARSE TRANSFER CUSTOM ID
   ========================================================= */

function parseTransferCustomId(
  customId
) {
  const parts =
    String(
      customId || ''
    ).split(':');

  if (
    parts.length !==
    4
  ) {
    return null;
  }

  const [
    action,
    channelId,
    ownerId,
    targetId
  ] = parts;

  if (
    action !==
      'voice_transfer_accept' &&
    action !==
      'voice_transfer_decline'
  ) {
    return null;
  }

  if (
    !isSnowflake(
      channelId
    ) ||
    !isSnowflake(
      ownerId
    ) ||
    !isSnowflake(
      targetId
    )
  ) {
    return null;
  }

  return {
    action,
    channelId,
    ownerId,
    targetId
  };
}


/* =========================================================
   P4 — DECLINE TRANSFER
   ========================================================= */

async function handleTransferDecline(
  interaction,
  parsed
) {
  if (
    String(
      interaction.user.id
    ) !==
      String(
        parsed.targetId
      )
  ) {
    return tempInteractionNotice(
      interaction,
      'Chỉ người được mời nhận phòng mới có thể từ chối.',
      'warning'
    );
  }

  const pending =
    getPendingTransfer(
      parsed.channelId
    );

  if (
    !pending ||
    pending.ownerId !==
      String(
        parsed.ownerId
      ) ||
    pending.targetId !==
      String(
        parsed.targetId
      )
  ) {
    return tempInteractionNotice(
      interaction,
      'Yêu cầu chuyển chủ này đã hết hiệu lực.',
      'warning'
    );
  }

  clearPendingTransfer(
    parsed.channelId
  );

  try {
    await interaction.update({
      content:
        `🟠 <@${parsed.targetId}> đã từ chối nhận quyền chủ phòng.`,

      components:
        []
    });

    scheduleMessageDelete(
      interaction.message
    );
  } catch (error) {
    logError(
      'TRANSFER_DECLINE',
      error
    );
  }
}


/* =========================================================
   P4 — ACCEPT TRANSFER
   ========================================================= */

async function handleTransferAccept(
  interaction,
  parsed
) {
  if (
    String(
      interaction.user.id
    ) !==
      String(
        parsed.targetId
      )
  ) {
    return tempInteractionNotice(
      interaction,
      'Chỉ người được mời nhận phòng mới có thể đồng ý.',
      'warning'
    );
  }

  const pending =
    getPendingTransfer(
      parsed.channelId
    );

  if (
    !pending ||
    pending.ownerId !==
      String(
        parsed.ownerId
      ) ||
    pending.targetId !==
      String(
        parsed.targetId
      )
  ) {
    return tempInteractionNotice(
      interaction,
      'Yêu cầu chuyển chủ này đã hết hiệu lực.',
      'warning'
    );
  }

  const channel =
    await fetchChannelSafe(
      interaction.guild,
      parsed.channelId
    );

  if (
    !isVoiceChannel(
      channel
    )
  ) {
    clearPendingTransfer(
      parsed.channelId
    );

    return tempInteractionNotice(
      interaction,
      'Phòng không còn tồn tại.',
      'warning'
    );
  }

  let room =
    await getRoom(
      channel.id
    );

  if (
    !room ||
    String(
      room.owner_id
    ) !==
      String(
        parsed.ownerId
      )
  ) {
    clearPendingTransfer(
      parsed.channelId
    );

    return tempInteractionNotice(
      interaction,
      'Chủ phòng đã thay đổi. Yêu cầu này không còn hiệu lực.',
      'warning'
    );
  }

  /*
   * Chủ cũ vẫn phải là chủ tại thời điểm Accept.
   */
  const oldOwner =
    await fetchMemberWithVoiceState(
      interaction.guild,
      parsed.ownerId
    );

  if (!oldOwner) {
    clearPendingTransfer(
      parsed.channelId
    );

    return tempInteractionNotice(
      interaction,
      'Không còn xác định được chủ phòng hiện tại.',
      'warning'
    );
  }

  /*
   * Target phải vẫn ở exact room tại thời điểm Accept.
   */
  const validation =
    await validateTransferTarget(
      interaction.guild,
      channel,
      room,
      parsed.targetId
    );

  if (!validation.ok) {
    clearPendingTransfer(
      parsed.channelId
    );

    try {
      await interaction.update({
        content:
          validation.reason ===
            'NOT_IN_ROOM'
            ? `🟠 <@${parsed.targetId}> không còn ở trong phòng. Yêu cầu chuyển chủ đã hủy.`
            : '🟠 Không thể hoàn tất chuyển chủ.',

        components:
          []
      });

      scheduleMessageDelete(
        interaction.message
      );
    } catch (_) {}

    return;
  }

  /*
   * Revalidate lần cuối ngay trước DB change.
   */
  const target =
    await resolveMemberInExactRoom(
      interaction.guild,
      parsed.targetId,
      channel.id
    );

  if (!target) {
    clearPendingTransfer(
      parsed.channelId
    );

    try {
      await interaction.update({
        content:
          `🟠 <@${parsed.targetId}> không còn ở trong phòng. Yêu cầu chuyển chủ đã hủy.`,

        components:
          []
      });

      scheduleMessageDelete(
        interaction.message
      );
    } catch (_) {}

    return;
  }

  await interaction.deferUpdate();

  /*
   * Cấp quyền owner mới trước.
   * Nếu Discord permission thất bại thì DB chưa đổi.
   */
  const granted =
    await grantRoomOwnerPermissions(
      channel,
      target
    );

  if (!granted) {
    clearPendingTransfer(
      parsed.channelId
    );

    await tempInteractionNotice(
      interaction,
      'Không thể cấp quyền cho chủ phòng mới.',
      'error'
    );

    return;
  }

  /*
   * Sau khi quyền mới đã có mới cập nhật DB.
   */
  try {
    room =
      await updateRoomOwner(
        channel.id,
        target.id
      );
  } catch (error) {
    logError(
      `TRANSFER_DB:${channel.id}`,
      error
    );

    /*
     * DB thất bại -> bỏ overwrite vừa cấp
     * cho target để tránh hai owner.
     */
    await removeMemberRoomOverride(
      channel,
      target
    ).catch(
      () => {}
    );

    clearPendingTransfer(
      parsed.channelId
    );

    await tempInteractionNotice(
      interaction,
      'Không thể lưu chủ phòng mới.',
      'error'
    );

    return;
  }

  /*
   * DB đã chuyển thành công.
   * Thu hồi direct owner permission của chủ cũ.
   */
  await revokeRoomOwnerPermissions(
    channel,
    oldOwner
  );

  /*
   * Đảm bảo owner mới vẫn có đúng permission.
   */
  await grantRoomOwnerPermissions(
    channel,
    target
  );

  /*
   * Owner absence cũ không còn giá trị.
   */
  await deleteOwnerAbsence(
    channel.id
  ).catch(
    () => {}
  );

  const absenceTimer =
    ownerAbsenceTimers.get(
      String(
        channel.id
      )
    );

  if (absenceTimer) {
    clearTimeout(
      absenceTimer
    );

    ownerAbsenceTimers.delete(
      String(
        channel.id
      )
    );
  }

  clearPendingTransfer(
    parsed.channelId
  );

  clearSelectedMember(
    interaction.guildId,
    parsed.ownerId
  );

  await refreshRoomPanel(
    channel,
    target.id
  );

  try {
    await interaction.message.edit({
      content:
        `🟢 <@${target.id}> đã trở thành chủ phòng mới.`,

      components:
        []
    });

    scheduleMessageDelete(
      interaction.message
    );
  } catch (_) {}

  await sendActionLog(
    interaction.guild,
    `${target.user.tag} nhận quyền chủ phòng ${channel.name} từ ${oldOwner.user.tag}.`
  );
}


/* =========================================================
   P4 — TRANSFER ROUTER
   ========================================================= */

async function handleTransferInteraction(
  interaction
) {
  const parsed =
    parseTransferCustomId(
      interaction.customId
    );

  if (!parsed) {
    return false;
  }

  if (
    parsed.action ===
    'voice_transfer_accept'
  ) {
    await handleTransferAccept(
      interaction,
      parsed
    );

    return true;
  }

  if (
    parsed.action ===
    'voice_transfer_decline'
  ) {
    await handleTransferDecline(
      interaction,
      parsed
    );

    return true;
  }

  return false;
}


/* =========================================================
   P4 — MAIN PANEL BUTTON ROUTER
   ========================================================= */

async function handleRoomPanelButton(
  interaction
) {
  switch (
    interaction.customId
  ) {
    case 'voice_room_lock':
      await handleRoomLockButton(
        interaction
      );
      return true;

    case 'voice_room_hide':
      await handleRoomHideButton(
        interaction
      );
      return true;

    case 'voice_room_rename':
      await handleRoomRenameButton(
        interaction
      );
      return true;

    case 'voice_room_reset':
      await handleRoomResetButton(
        interaction
      );
      return true;

    case 'voice_room_limit':
      await handleRoomLimitButton(
        interaction
      );
      return true;

    case 'voice_room_invite':
      await handleRoomInviteButton(
        interaction
      );
      return true;

    case 'voice_room_transfer':
      await handleRoomTransferButton(
        interaction
      );
      return true;

    case 'voice_room_ban':
      await handleRoomBanButton(
        interaction
      );
      return true;

    case 'voice_room_kick':
      await handleRoomKickButton(
        interaction
      );
      return true;

    default:
      return false;
  }
}


/* =========================================================
   P4 — PANEL SELECT ROUTER
   ========================================================= */

async function handleRoomPanelSelect(
  interaction
) {
  switch (
    interaction.customId
  ) {
    case 'voice_room_member_select':
      await handleRoomMemberSelect(
        interaction
      );
      return true;

    case 'voice_room_region_select':
      await handleRoomRegionSelect(
        interaction
      );
      return true;

    default:
      return false;
  }
}


/* =========================================================
   P4 — PANEL MODAL ROUTER
   ========================================================= */

async function handleRoomPanelModal(
  interaction
) {
  switch (
    interaction.customId
  ) {
    case 'voice_room_rename_modal':
      await handleRoomRenameModal(
        interaction
      );
      return true;

    case 'voice_room_limit_modal':
      await handleRoomLimitModal(
        interaction
      );
      return true;

    default:
      return false;
  }
}
/* =========================================================
   P5 — CREATE LOCK
   ========================================================= */

function createLockKey(
  guildId,
  memberId
) {
  return (
    `${String(guildId)}:` +
    `${String(memberId)}`
  );
}

async function withCreateLock(
  guildId,
  memberId,
  callback
) {
  const key =
    createLockKey(
      guildId,
      memberId
    );

  const existing =
    createLocks.get(
      key
    );

  if (existing) {
    return existing;
  }

  const task =
    (async () => {
      try {
        return await callback();
      } finally {
        if (
          createLocks.get(
            key
          ) === task
        ) {
          createLocks.delete(
            key
          );
        }
      }
    })();

  createLocks.set(
    key,
    task
  );

  return task;
}


/* =========================================================
   P5 — ROOM LIFECYCLE LOCK
   ========================================================= */

async function withRoomLifecycleLock(
  channelId,
  callback
) {
  const id =
    String(channelId);

  const existing =
    roomLifecycleLocks.get(
      id
    );

  if (existing) {
    return existing;
  }

  const task =
    (async () => {
      try {
        return await callback();
      } finally {
        if (
          roomLifecycleLocks.get(
            id
          ) === task
        ) {
          roomLifecycleLocks.delete(
            id
          );
        }
      }
    })();

  roomLifecycleLocks.set(
    id,
    task
  );

  return task;
}


/* =========================================================
   P5 — ROOM NAME
   ========================================================= */

function buildDefaultRoomName(
  member
) {
  let name =
    String(
      member?.displayName ||
      member?.user?.globalName ||
      member?.user?.username ||
      'Phòng'
    )
      .replace(/\s+/g, ' ')
      .trim();

  /*
   * Discord channel name tối đa 100 ký tự.
   * Chừa chỗ cho prefix.
   */
  name =
    name.slice(
      0,
      Math.max(
        1,
        100 -
        ROOM_PREFIX.length
      )
    );

  return (
    `${ROOM_PREFIX}${name}`
  );
}


/* =========================================================
   P5 — CANCEL EMPTY DELETE
   ========================================================= */

function cancelEmptyRoomDelete(
  channelId
) {
  const id =
    String(channelId);

  const timer =
    emptyRoomTimers.get(
      id
    );

  if (!timer) {
    return;
  }

  clearTimeout(
    timer
  );

  emptyRoomTimers.delete(
    id
  );
}


/* =========================================================
   P5 — PRESENCE SYNC
   ========================================================= */

async function syncRoomPresence(
  channel,
  room
) {
  if (
    !channel ||
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

  let saved = [];

  try {
    saved =
      await getRoomPresence(
        channel.id
      );
  } catch (error) {
    logError(
      `GET_PRESENCE:${channel.id}`,
      error
    );
  }

  const savedIds =
    new Set(
      saved.map(
        row =>
          String(
            row.member_id
          )
      )
    );

  /*
   * Người đang ở phòng nhưng DB chưa có:
   * thêm với thời điểm hiện tại.
   */
  for (
    const member
    of humans
  ) {
    if (
      savedIds.has(
        String(
          member.id
        )
      )
    ) {
      continue;
    }

    try {
      await recordMemberPresence(
        channel.guild.id,
        channel.id,
        member.id,
        new Date()
      );
    } catch (error) {
      logError(
        `ADD_PRESENCE:${channel.id}:${member.id}`,
        error
      );
    }
  }

  /*
   * DB còn người nhưng thực tế đã rời phòng:
   * xóa stale presence.
   */
  for (
    const row
    of saved
  ) {
    if (
      currentIds.has(
        String(
          row.member_id
        )
      )
    ) {
      continue;
    }

    try {
      await removeMemberPresence(
        channel.id,
        row.member_id
      );
    } catch (error) {
      logError(
        `REMOVE_STALE_PRESENCE:${channel.id}:${row.member_id}`,
        error
      );
    }
  }
}


/* =========================================================
   P5 — STALE OWNED ROOM CLEANUP
   ========================================================= */

async function resolveValidOwnedRoom(
  guild,
  ownerId
) {
  const room =
    await getOwnedRoom(
      guild.id,
      ownerId
    );

  if (!room) {
    return null;
  }

  const channel =
    await fetchChannelSafe(
      guild,
      room.channel_id
    );

  /*
   * DB còn record nhưng Discord channel mất:
   * dọn record stale.
   */
  if (
    !channel ||
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
        `STALE_OWNED_ROOM:${room.channel_id}`,
        error
      );
    }

    clearRoomRuntimeState(
      room.channel_id
    );

    return null;
  }

  /*
   * Record phải thuộc đúng guild.
   */
  if (
    String(
      room.guild_id
    ) !==
      String(
        guild.id
      )
  ) {
    return null;
  }

  return {
    room,
    channel
  };
}


/* =========================================================
   P5 — GENERATOR POSITION
   ========================================================= */

async function ensureGeneratorPosition(
  guild,
  generator
) {
  if (
    !guild ||
    !generator?.create_voice_id ||
    !generator?.button_category_id
  ) {
    return false;
  }

  const generatorChannel =
    await fetchChannelSafe(
      guild,
      generator.create_voice_id
    );

  const category =
    await fetchChannelSafe(
      guild,
      generator.button_category_id
    );

  if (
    !isVoiceChannel(
      generatorChannel
    ) ||
    !isCategoryChannel(
      category
    )
  ) {
    return false;
  }

  if (
    String(
      generatorChannel.parentId
    ) !==
      String(
        category.id
      )
  ) {
    return false;
  }

  try {
    /*
     * Đưa generator lên đầu category.
     */
    await generatorChannel.setPosition(
      0,
      {
        reason:
          `${BOT_NAME} giữ nút tạo phòng ở trên cùng`
      }
    );

    return true;
  } catch (error) {
    logError(
      `GENERATOR_POSITION:${guild.id}`,
      error
    );

    return false;
  }
}


/* =========================================================
   P5 — TEMP ROOM POSITION
   ========================================================= */

async function positionTempRoomBelowGenerator(
  channel,
  generator
) {
  if (
    !channel ||
    !generator?.create_voice_id
  ) {
    return;
  }

  const generatorChannel =
    await fetchChannelSafe(
      channel.guild,
      generator.create_voice_id
    );

  if (
    !generatorChannel ||
    String(
      generatorChannel.parentId
    ) !==
      String(
        channel.parentId
      )
  ) {
    return;
  }

  try {
    /*
     * Generator ở vị trí trên cùng.
     * Phòng temp nằm ngay sau generator / các temp room khác.
     */
    const siblingTempRooms =
      (
        await getGuildRooms(
          channel.guild.id
        )
      )
        .filter(
          room =>
            String(
              room.channel_id
            ) !==
              String(
                channel.id
              ) &&
            String(
              room.category_id
            ) ===
              String(
                channel.parentId
              )
        );

    const position =
      Math.max(
        1,
        generatorChannel.position +
        siblingTempRooms.length +
        1
      );

    await channel.setPosition(
      position,
      {
        reason:
          `${BOT_NAME} sắp xếp phòng tạm`
      }
    );
  } catch (error) {
    logError(
      `TEMP_ROOM_POSITION:${channel.id}`,
      error
    );
  }
}


/* =========================================================
   P5 — CREATE TEMP ROOM
   ========================================================= */

async function createManagedTempRoom(
  guild,
  member,
  generator
) {
  if (
    !guild ||
    !member ||
    !generator
  ) {
    return {
      ok:
        false,

      reason:
        'INVALID_INPUT'
    };
  }

  const category =
    await fetchChannelSafe(
      guild,
      generator.button_category_id
    );

  if (
    !isCategoryChannel(
      category
    )
  ) {
    return {
      ok:
        false,

      reason:
        'CATEGORY_MISSING'
    };
  }

  /*
   * Kiểm tra lần nữa trước create.
   */
  const existing =
    await resolveValidOwnedRoom(
      guild,
      member.id
    );

  if (existing) {
    return {
      ok:
        true,

      existing:
        true,

      room:
        existing.room,

      channel:
        existing.channel
    };
  }

  let channel =
    null;

  try {
    channel =
      await guild.channels.create({
        name:
          buildDefaultRoomName(
            member
          ),

        type:
          ChannelType.GuildVoice,

        parent:
          category.id,

        reason:
          `${BOT_NAME} tạo phòng tạm cho ${member.user.tag}`
      });
  } catch (error) {
    logError(
      `CREATE_TEMP_ROOM:${guild.id}:${member.id}`,
      error
    );

    return {
      ok:
        false,

      reason:
        'CHANNEL_CREATE_FAILED'
    };
  }

  let room =
    null;

  try {
    room =
      await createRoomRecord({
        channelId:
          channel.id,

        guildId:
          guild.id,

        ownerId:
          member.id,

        categoryId:
          category.id,

        controlMessageId:
          null
      });
  } catch (error) {
    logError(
      `CREATE_ROOM_DB:${channel.id}`,
      error
    );

    /*
     * DB không ghi được thì channel chưa được quản lý.
     * Xóa ngay để không tạo orphan.
     */
    await safeDeleteChannel(
      channel,
      `${BOT_NAME} rollback phòng lỗi database`
    );

    return {
      ok:
        false,

      reason:
        'DATABASE_FAILED'
    };
  }

  /*
   * Cấp owner permission trước khi move.
   */
  const ownerPermission =
    await grantRoomOwnerPermissions(
      channel,
      member
    );

  if (!ownerPermission) {
    await safeDeleteChannel(
      channel,
      `${BOT_NAME} rollback phòng lỗi quyền`
    );

    await deleteRoomRecord(
      channel.id
    ).catch(
      () => {}
    );

    return {
      ok:
        false,

      reason:
        'OWNER_PERMISSION_FAILED'
    };
  }

  /*
   * Tạo panel TRƯỚC khi move owner.
   */
  const panel =
    await ensureRoomPanel(
      channel,
      room,
      member.id
    );

  if (!panel) {
    await safeDeleteChannel(
      channel,
      `${BOT_NAME} rollback phòng lỗi panel`
    );

    await deleteRoomRecord(
      channel.id
    ).catch(
      () => {}
    );

    return {
      ok:
        false,

      reason:
        'PANEL_FAILED'
    };
  }

  /*
   * Record presence trước khi move không được ghi,
   * vì user vẫn đang ở generator.
   *
   * Move xong mới ghi presence.
   */
  const moved =
    await safeMoveMember(
      member,
      channel,
      `${BOT_NAME} đưa chủ phòng vào phòng mới`
    );

  if (!moved) {
    /*
     * Nếu user đã tự rời generator trong lúc create,
     * không giữ lại phòng rỗng.
     */
    const freshMember =
      await fetchMemberWithVoiceState(
        guild,
        member.id
      );

    if (
      getMemberVoiceChannelId(
        freshMember
      ) !==
        String(
          channel.id
        )
    ) {
      await deleteManagedRoomDiscordFirst(
        guild,
        channel.id,
        `${BOT_NAME} rollback phòng không thể di chuyển chủ`
      );

      return {
        ok:
          false,

        reason:
          'MOVE_FAILED'
      };
    }
  }

  /*
   * Xác minh owner thực sự đang ở phòng.
   */
  const ownerInRoom =
    await resolveMemberInExactRoom(
      guild,
      member.id,
      channel.id
    );

  if (ownerInRoom) {
    await recordMemberPresence(
      guild.id,
      channel.id,
      member.id,
      new Date()
    ).catch(
      error => {
        logError(
          `OWNER_PRESENCE:${channel.id}`,
          error
        );
      }
    );
  }

  await positionTempRoomBelowGenerator(
    channel,
    generator
  );

  await refreshRoomPanel(
    channel,
    member.id
  );

  await sendActionLog(
    guild,
    `${member.user.tag} tạo phòng ${channel.name}.`
  );

  return {
    ok:
      true,

    existing:
      false,

    room:
      await getRoom(
        channel.id
      ) || room,

    channel
  };
}


/* =========================================================
   P5 — ENTER GENERATOR
   ========================================================= */

async function handleGeneratorJoin(
  member,
  generatorChannel
) {
  if (
    !member ||
    !generatorChannel ||
    member.user?.bot
  ) {
    return;
  }

  const guild =
    generatorChannel.guild;

  if (
    setupCleanupGuilds.has(
      String(
        guild.id
      )
    )
  ) {
    return;
  }

  const generator =
    await getGenerator(
      guild.id
    );

  if (
    !generator ||
    String(
      generator.create_voice_id
    ) !==
      String(
        generatorChannel.id
      )
  ) {
    return;
  }

  /*
   * Generator phải vẫn nằm đúng category đã setup.
   * Không adopt channel cùng tên.
   */
  if (
    String(
      generatorChannel.parentId
    ) !==
      String(
        generator.button_category_id
      )
  ) {
    return;
  }

  return withCreateLock(
    guild.id,
    member.id,
    async () => {
      /*
       * User có thể đã rời generator trong lúc chờ lock.
       */
      let freshMember =
        await fetchMemberWithVoiceState(
          guild,
          member.id
        );

      if (
        !freshMember ||
        getMemberVoiceChannelId(
          freshMember
        ) !==
          String(
            generatorChannel.id
          )
      ) {
        return;
      }

      /*
       * Một owner chỉ có một room.
       */
      const existing =
        await resolveValidOwnedRoom(
          guild,
          member.id
        );

      if (existing) {
        /*
         * Panel cũ có thể bị xóa thủ công.
         * Repair trước khi move.
         */
        await ensureRoomPanel(
          existing.channel,
          existing.room,
          member.id
        );

        /*
         * Fetch lại lần cuối để tránh move người
         * đã rời generator sang room ngoài ý muốn.
         */
        freshMember =
          await fetchMemberWithVoiceState(
            guild,
            member.id
          );

        if (
          !freshMember ||
          getMemberVoiceChannelId(
            freshMember
          ) !==
            String(
              generatorChannel.id
            )
        ) {
          return;
        }

        const moved =
          await safeMoveMember(
            freshMember,
            existing.channel,
            `${BOT_NAME} đưa chủ phòng về phòng hiện có`
          );

        if (moved) {
          await recordMemberPresence(
            guild.id,
            existing.channel.id,
            freshMember.id,
            new Date()
          ).catch(
            () => {}
          );

          cancelEmptyRoomDelete(
            existing.channel.id
          );

          await refreshRoomPanel(
            existing.channel,
            member.id
          );
        }

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


/* =========================================================
   P5 — SCHEDULE EMPTY ROOM DELETE
   ========================================================= */

function scheduleEmptyRoomDelete(
  guild,
  channelId
) {
  const id =
    String(channelId);

  if (
    emptyRoomTimers.has(
      id
    )
  ) {
    return;
  }

  const timer =
    setTimeout(
      async () => {
        emptyRoomTimers.delete(
          id
        );

        try {
          await withRoomLifecycleLock(
            id,
            async () => {
              const room =
                await getRoom(
                  id
                );

              if (!room) {
                clearRoomRuntimeState(
                  id
                );

                return;
              }

              const channel =
                await fetchChannelSafe(
                  guild,
                  id
                );

              /*
               * Channel đã bị xóa thủ công:
               * chỉ cleanup stale DB.
               */
              if (!channel) {
                await deleteRoomRecord(
                  id
                );

                clearRoomRuntimeState(
                  id
                );

                return;
              }

              /*
               * Sau delay phải kiểm tra lại actual members.
               */
              const humans =
                humanMembers(
                  channel
                );

              if (
                humans.length >
                0
              ) {
                return;
              }

              /*
               * Hủy pending transfer / absence trước.
               */
              clearPendingTransfer(
                id
              );

              const absenceTimer =
                ownerAbsenceTimers.get(
                  id
                );

              if (absenceTimer) {
                clearTimeout(
                  absenceTimer
                );

                ownerAbsenceTimers.delete(
                  id
                );
              }

              /*
               * QUAN TRỌNG:
               * Discord channel trước -> DB sau.
               */
              const result =
                await deleteManagedRoomDiscordFirst(
                  guild,
                  id,
                  `${BOT_NAME} xóa phòng trống`
                );

              if (!result.ok) {
                return;
              }

              await sendActionLog(
                guild,
                `Đã xóa phòng trống ${id}.`
              );
            }
          );
        } catch (error) {
          logError(
            `EMPTY_ROOM_DELETE:${id}`,
            error
          );
        }
      },
      EMPTY_ROOM_DELETE_DELAY_MS
    );

  if (
    typeof timer.unref ===
    'function'
  ) {
    timer.unref();
  }

  emptyRoomTimers.set(
    id,
    timer
  );
}


/* =========================================================
   P5 — MEMBER ENTERS MANAGED ROOM
   ========================================================= */

async function handleManagedRoomJoin(
  member,
  channel,
  room
) {
  if (
    !member ||
    !channel ||
    !room ||
    member.user?.bot
  ) {
    return;
  }

  cancelEmptyRoomDelete(
    channel.id
  );

  /*
   * Presence dùng cho auto-transfer P6.
   */
  await recordMemberPresence(
    channel.guild.id,
    channel.id,
    member.id,
    new Date()
  ).catch(
    error => {
      logError(
        `ROOM_JOIN_PRESENCE:${channel.id}:${member.id}`,
        error
      );
    }
  );

  /*
   * Nếu người vừa quay lại là owner,
   * P6 sẽ xử lý hủy absence.
   * Ở P5 chỉ refresh panel.
   */
  await refreshRoomPanel(
    channel,
    room.owner_id
  ).catch(
    () => {}
  );
}


/* =========================================================
   P5 — MEMBER LEAVES MANAGED ROOM
   ========================================================= */

async function handleManagedRoomLeave(
  member,
  channel,
  room
) {
  if (
    !member ||
    !channel ||
    !room ||
    member.user?.bot
  ) {
    return;
  }

  await removeMemberPresence(
    channel.id,
    member.id
  ).catch(
    error => {
      logError(
        `ROOM_LEAVE_PRESENCE:${channel.id}:${member.id}`,
        error
      );
    }
  );

  /*
   * Fetch channel lại để lấy state thành viên mới nhất.
   */
  const refreshed =
    await fetchChannelSafe(
      channel.guild,
      channel.id
    );

  if (!refreshed) {
    /*
     * Channel biến mất:
     * dọn stale DB.
     */
    await deleteRoomRecord(
      channel.id
    ).catch(
      () => {}
    );

    clearRoomRuntimeState(
      channel.id
    );

    return;
  }

  const humans =
    humanMembers(
      refreshed
    );

  if (
    humans.length ===
    0
  ) {
    /*
     * Phòng trống luôn ưu tiên lifecycle delete.
     * Không bắt đầu owner absence.
     */
    scheduleEmptyRoomDelete(
      channel.guild,
      channel.id
    );

    return;
  }

  await refreshRoomPanel(
    refreshed,
    room.owner_id
  ).catch(
    () => {}
  );
}


/* =========================================================
   P5 — MANAGED VOICE STATE TRANSITION
   ========================================================= */

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

  if (
    setupCleanupGuilds.has(
      String(
        guild.id
      )
    )
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

  /*
   * Mute/deafen/stream thay đổi nhưng channel không đổi.
   * Không xử lý lifecycle.
   */
  if (
    oldChannelId ===
    newChannelId
  ) {
    return;
  }

  /*
   * -----------------------------------------------------
   * LEAVE OLD MANAGED ROOM
   * -----------------------------------------------------
   */

  if (oldChannelId) {
    const oldRoom =
      await getRoom(
        oldChannelId
      ).catch(
        () => null
      );

    if (oldRoom) {
      const oldChannel =
        oldState.channel ||
        await fetchChannelSafe(
          guild,
          oldChannelId
        );

      if (oldChannel) {
        await handleManagedRoomLeave(
          member,
          oldChannel,
          oldRoom
        );
      } else {
        await deleteRoomRecord(
          oldChannelId
        ).catch(
          () => {}
        );

        clearRoomRuntimeState(
          oldChannelId
        );
      }
    }
  }

  /*
   * -----------------------------------------------------
   * GENERATOR JOIN
   * -----------------------------------------------------
   */

  if (newChannelId) {
    const generator =
      await getGenerator(
        guild.id
      ).catch(
        () => null
      );

    if (
      generator?.create_voice_id &&
      String(
        generator.create_voice_id
      ) ===
        newChannelId
    ) {
      const generatorChannel =
        newState.channel ||
        await fetchChannelSafe(
          guild,
          newChannelId
        );

      if (
        isVoiceChannel(
          generatorChannel
        )
      ) {
        await handleGeneratorJoin(
          member,
          generatorChannel
        );
      }

      /*
       * Không tiếp tục xử lý generator như temp room.
       */
      return;
    }
  }

  /*
   * -----------------------------------------------------
   * JOIN NEW MANAGED ROOM
   * -----------------------------------------------------
   */

  if (newChannelId) {
    const newRoom =
      await getRoom(
        newChannelId
      ).catch(
        () => null
      );

    if (newRoom) {
      const newChannel =
        newState.channel ||
        await fetchChannelSafe(
          guild,
          newChannelId
        );

      if (newChannel) {
        await handleManagedRoomJoin(
          member,
          newChannel,
          newRoom
        );
      }
    }
  }
}


/* =========================================================
   P5 — GENERATOR MANUAL DELETE
   ========================================================= */

async function handleTrackedGeneratorDeleted(
  channel
) {
  if (
    !channel?.guild
  ) {
    return false;
  }

  const guild =
    channel.guild;

  const generator =
    await getGenerator(
      guild.id
    ).catch(
      () => null
    );

  if (
    !generator ||
    String(
      generator.create_voice_id ||
      ''
    ) !==
      String(
        channel.id
      )
  ) {
    return false;
  }

  /*
   * Nếu đang /setup cleanup thì P7 sẽ xóa toàn bộ config.
   * Không tranh chấp tại đây.
   */
  if (
    setupCleanupGuilds.has(
      String(
        guild.id
      )
    )
  ) {
    return true;
  }

  /*
   * Generator bị admin xóa thủ công:
   * KHÔNG recreate.
   *
   * Chỉ clear create_voice_id để bot ngừng theo dõi.
   * Giữ phần config còn lại để /setup có thể cleanup.
   */
  try {
    await pool.query(
      `
        UPDATE generators
        SET
          create_voice_id = NULL,
          updated_at = NOW()
        WHERE
          guild_id = $1
          AND create_voice_id = $2
      `,
      [
        String(
          guild.id
        ),
        String(
          channel.id
        )
      ]
    );

    await sendActionLog(
      guild,
      'Kênh ➕ Tạo phòng đã bị xóa thủ công. Voice HDK sẽ không tự tạo lại; hãy dùng /setup để cài lại.'
    );
  } catch (error) {
    logError(
      `GENERATOR_MANUAL_DELETE:${guild.id}`,
      error
    );
  }

  return true;
}


/* =========================================================
   P5 — MANAGED ROOM MANUAL DELETE
   ========================================================= */

async function handleTrackedRoomDeleted(
  channel
) {
  if (
    !channel?.guild
  ) {
    return false;
  }

  const room =
    await getRoom(
      channel.id
    ).catch(
      () => null
    );

  if (!room) {
    return false;
  }

  /*
   * Discord channel đã mất rồi.
   * Dọn DB + runtime.
   */
  try {
    await deleteRoomRecord(
      channel.id
    );

    clearRoomRuntimeState(
      channel.id
    );
  } catch (error) {
    logError(
      `MANAGED_ROOM_MANUAL_DELETE:${channel.id}`,
      error
    );
  }

  return true;
}


/* =========================================================
   P5 — TRACKED LOG CHANNEL MANUAL DELETE
   ========================================================= */

async function handleTrackedLogChannelDeleted(
  channel
) {
  if (
    !channel?.guild
  ) {
    return false;
  }

  const guild =
    channel.guild;

  const generator =
    await getGenerator(
      guild.id
    ).catch(
      () => null
    );

  if (!generator) {
    return false;
  }

  if (
    setupCleanupGuilds.has(
      String(
        guild.id
      )
    )
  ) {
    return false;
  }

  const channelId =
    String(
      channel.id
    );

  const isChatLog =
    String(
      generator.chat_log_channel_id ||
      ''
    ) ===
      channelId;

  const isActionLog =
    String(
      generator.action_log_channel_id ||
      ''
    ) ===
      channelId;

  if (
    !isChatLog &&
    !isActionLog
  ) {
    return false;
  }

  try {
    if (
      isChatLog &&
      isActionLog
    ) {
      await pool.query(
        `
          UPDATE generators
          SET
            chat_log_channel_id = NULL,
            action_log_channel_id = NULL,
            updated_at = NOW()
          WHERE guild_id = $1
        `,
        [
          String(
            guild.id
          )
        ]
      );
    } else if (
      isChatLog
    ) {
      await pool.query(
        `
          UPDATE generators
          SET
            chat_log_channel_id = NULL,
            updated_at = NOW()
          WHERE guild_id = $1
        `,
        [
          String(
            guild.id
          )
        ]
      );
    } else {
      await pool.query(
        `
          UPDATE generators
          SET
            action_log_channel_id = NULL,
            updated_at = NOW()
          WHERE guild_id = $1
        `,
        [
          String(
            guild.id
          )
        ]
      );
    }
  } catch (error) {
    logError(
      `LOG_CHANNEL_MANUAL_DELETE:${guild.id}`,
      error
    );
  }

  return true;
}


/* =========================================================
   P5 — CHANNEL DELETE RECONCILE
   ========================================================= */

async function handleManagedChannelDelete(
  channel
) {
  if (
    !channel?.guild
  ) {
    return;
  }

  /*
   * /setup cleanup chủ động xóa các channel.
   * Không để ChannelDelete event tự thay DB giữa transaction.
   */
  if (
    setupCleanupGuilds.has(
      String(
        channel.guild.id
      )
    )
  ) {
    return;
  }

  const generatorHandled =
    await handleTrackedGeneratorDeleted(
      channel
    );

  if (generatorHandled) {
    return;
  }

  const roomHandled =
    await handleTrackedRoomDeleted(
      channel
    );

  if (roomHandled) {
    return;
  }

  await handleTrackedLogChannelDeleted(
    channel
  );
}


/* =========================================================
   P5 — ROOM PANEL PRESENCE REFRESH
   ========================================================= */

async function refreshManagedRoomMemberCount(
  channelId,
  guild
) {
  const room =
    await getRoom(
      channelId
    ).catch(
      () => null
    );

  if (!room) {
    return;
  }

  const channel =
    await fetchChannelSafe(
      guild,
      channelId
    );

  if (!channel) {
    return;
  }

  await refreshRoomPanel(
    channel,
    room.owner_id
  ).catch(
    () => {}
  );
}
/* =========================================================
   P6 — OWNER ABSENCE TIMER
   ========================================================= */

function cancelOwnerAbsenceTimer(
  channelId
) {
  const id =
    String(channelId);

  const timer =
    ownerAbsenceTimers.get(
      id
    );

  if (timer) {
    clearTimeout(
      timer
    );

    ownerAbsenceTimers.delete(
      id
    );
  }
}


/* =========================================================
   P6 — OWNER ABSENCE NOTICE
   ========================================================= */

async function fetchAbsenceNotice(
  channel,
  absence
) {
  if (
    !channel ||
    !absence?.notice_message_id
  ) {
    return null;
  }

  try {
    return await channel.messages.fetch(
      String(
        absence.notice_message_id
      )
    );
  } catch (_) {
    return null;
  }
}

async function deleteAbsenceNotice(
  channel,
  absence
) {
  const message =
    await fetchAbsenceNotice(
      channel,
      absence
    );

  if (!message) {
    return;
  }

  try {
    await message.delete();
  } catch (_) {}
}

async function sendOwnerAbsenceNotice(
  channel,
  ownerId,
  deadlineAt
) {
  const unix =
    Math.floor(
      new Date(
        deadlineAt
      ).getTime() / 1000
    );

  try {
    return await channel.send({
      content: [
        `👑 <@${ownerId}> đã rời phòng.`,
        `Nếu chủ phòng không quay lại, quyền chủ sẽ được chuyển tự động <t:${unix}:R>.`
      ].join('\n')
    });
  } catch (error) {
    logError(
      `OWNER_ABSENCE_NOTICE:${channel.id}`,
      error
    );

    return null;
  }
}


/* =========================================================
   P6 — OWNER ACTUALLY IN ROOM
   ========================================================= */

async function ownerIsActuallyInRoom(
  guild,
  room
) {
  if (
    !guild ||
    !room
  ) {
    return false;
  }

  return memberIsInExactRoom(
    guild,
    room.owner_id,
    room.channel_id
  );
}


/* =========================================================
   P6 — OWNER RETURNS
   ========================================================= */

async function clearOwnerAbsenceBecauseReturned(
  channel,
  room,
  options = {}
) {
  const {
    notify = true
  } = options;

  const absence =
    await getOwnerAbsence(
      channel.id
    ).catch(
      () => null
    );

  cancelOwnerAbsenceTimer(
    channel.id
  );

  if (absence) {
    await deleteAbsenceNotice(
      channel,
      absence
    );

    await deleteOwnerAbsence(
      channel.id
    ).catch(
      error => {
        logError(
          `CLEAR_OWNER_ABSENCE:${channel.id}`,
          error
        );
      }
    );
  }

  if (notify) {
    try {
      const message =
        await channel.send({
          content:
            `🟢 <@${room.owner_id}> đã quay lại. Giữ nguyên quyền chủ phòng.`
        });

      scheduleMessageDelete(
        message
      );
    } catch (_) {}
  }

  await refreshRoomPanel(
    channel,
    room.owner_id
  ).catch(
    () => {}
  );
}


/* =========================================================
   P6 — AUTO TRANSFER CANDIDATES
   ========================================================= */

async function getAutoTransferCandidates(
  guild,
  channel,
  room
) {
  if (
    !guild ||
    !channel ||
    !room
  ) {
    return [];
  }

  /*
   * Sync trước để DB presence phản ánh
   * trạng thái voice thực tế.
   */
  await syncRoomPresence(
    channel,
    room
  );

  const presence =
    await getRoomPresence(
      channel.id
    ).catch(
      () => []
    );

  const joinedAtMap =
    new Map();

  for (
    const row
    of presence
  ) {
    joinedAtMap.set(
      String(
        row.member_id
      ),
      new Date(
        row.joined_at
      ).getTime()
    );
  }

  const humans =
    humanMembers(
      channel
    )
      .filter(
        member =>
          String(
            member.id
          ) !==
            String(
              room.owner_id
            )
      );

  const candidates = [];

  for (
    const member
    of humans
  ) {
    /*
     * Fetch/revalidate exact room.
     */
    const fresh =
      await resolveMemberInExactRoom(
        guild,
        member.id,
        channel.id
      );

    if (!fresh) {
      continue;
    }

    /*
     * Người đã sở hữu một managed room khác
     * không được nhận auto-transfer.
     */
    const owned =
      await getOwnedRoom(
        guild.id,
        fresh.id
      ).catch(
        () => null
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
      continue;
    }

    candidates.push({
      member:
        fresh,

      joinedAt:
        joinedAtMap.get(
          String(
            fresh.id
          )
        ) ||
        Date.now()
    });
  }

  /*
   * Người vào sớm nhất đứng đầu.
   */
  candidates.sort(
    (a, b) =>
      a.joinedAt -
      b.joinedAt
  );

  return candidates;
}


/* =========================================================
   P6 — APPLY AUTO OWNER TRANSFER
   ========================================================= */

async function applyAutomaticOwnerTransfer(
  guild,
  channel,
  room,
  newOwner
) {
  /*
   * Revalidate current room DB.
   */
  let currentRoom =
    await getRoom(
      channel.id
    );

  if (!currentRoom) {
    return {
      ok:
        false,

      reason:
        'ROOM_MISSING'
    };
  }

  if (
    String(
      currentRoom.owner_id
    ) !==
      String(
        room.owner_id
      )
  ) {
    return {
      ok:
        false,

      reason:
        'OWNER_CHANGED'
    };
  }

  /*
   * Chủ cũ quay lại đúng lúc timer hết
   * thì tuyệt đối không transfer.
   */
  if (
    await ownerIsActuallyInRoom(
      guild,
      currentRoom
    )
  ) {
    return {
      ok:
        false,

      reason:
        'OWNER_RETURNED'
    };
  }

  /*
   * New owner phải vẫn đang ở exact room.
   */
  const target =
    await resolveMemberInExactRoom(
      guild,
      newOwner.id,
      channel.id
    );

  if (!target) {
    return {
      ok:
        false,

      reason:
        'TARGET_LEFT'
    };
  }

  const owned =
    await getOwnedRoom(
      guild.id,
      target.id
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
    return {
      ok:
        false,

      reason:
        'TARGET_OWNS_ROOM'
    };
  }

  const oldOwner =
    await fetchMemberSafe(
      guild,
      currentRoom.owner_id
    );

  /*
   * Cấp quyền Discord trước.
   */
  const granted =
    await grantRoomOwnerPermissions(
      channel,
      target
    );

  if (!granted) {
    return {
      ok:
        false,

      reason:
        'PERMISSION_FAILED'
    };
  }

  /*
   * Kiểm tra chủ cũ thêm lần cuối ngay
   * trước DB update.
   */
  currentRoom =
    await getRoom(
      channel.id
    );

  if (
    !currentRoom ||
    String(
      currentRoom.owner_id
    ) !==
      String(
        room.owner_id
      )
  ) {
    await removeMemberRoomOverride(
      channel,
      target
    ).catch(
      () => {}
    );

    return {
      ok:
        false,

      reason:
        'OWNER_CHANGED'
    };
  }

  if (
    await ownerIsActuallyInRoom(
      guild,
      currentRoom
    )
  ) {
    await removeMemberRoomOverride(
      channel,
      target
    ).catch(
      () => {}
    );

    return {
      ok:
        false,

      reason:
        'OWNER_RETURNED'
    };
  }

  try {
    currentRoom =
      await updateRoomOwner(
        channel.id,
        target.id
      );
  } catch (error) {
    logError(
      `AUTO_TRANSFER_DB:${channel.id}`,
      error
    );

    await removeMemberRoomOverride(
      channel,
      target
    ).catch(
      () => {}
    );

    return {
      ok:
        false,

      reason:
        'DATABASE_FAILED'
    };
  }

  /*
   * DB thành công rồi mới thu hồi quyền chủ cũ.
   */
  if (oldOwner) {
    await revokeRoomOwnerPermissions(
      channel,
      oldOwner
    );
  }

  await grantRoomOwnerPermissions(
    channel,
    target
  );

  clearPendingTransfer(
    channel.id
  );

  await deleteOwnerAbsence(
    channel.id
  ).catch(
    () => {}
  );

  cancelOwnerAbsenceTimer(
    channel.id
  );

  await refreshRoomPanel(
    channel,
    target.id
  );

  await sendActionLog(
    guild,
    `${target.user.tag} được tự động chuyển quyền chủ phòng ${channel.name}.`
  );

  return {
    ok:
      true,

    room:
      currentRoom,

    member:
      target
  };
}


/* =========================================================
   P6 — AUTO TRANSFER RETRY
   ========================================================= */

async function scheduleAutoTransferRetry(
  guild,
  channelId
) {
  const id =
    String(channelId);

  cancelOwnerAbsenceTimer(
    id
  );

  const timer =
    setTimeout(
      async () => {
        ownerAbsenceTimers.delete(
          id
        );

        try {
          await processOwnerAbsenceExpiry(
            guild,
            id
          );
        } catch (error) {
          logError(
            `AUTO_TRANSFER_RETRY:${id}`,
            error
          );
        }
      },
      AUTO_TRANSFER_RETRY_MS
    );

  if (
    typeof timer.unref ===
    'function'
  ) {
    timer.unref();
  }

  ownerAbsenceTimers.set(
    id,
    timer
  );
}


/* =========================================================
   P6 — PROCESS ABSENCE EXPIRY
   ========================================================= */

async function processOwnerAbsenceExpiry(
  guild,
  channelId
) {
  const id =
    String(channelId);

  return withRoomLifecycleLock(
    id,
    async () => {
      let room =
        await getRoom(
          id
        );

      if (!room) {
        cancelOwnerAbsenceTimer(
          id
        );

        return;
      }

      const channel =
        await fetchChannelSafe(
          guild,
          id
        );

      if (!channel) {
        await deleteRoomRecord(
          id
        ).catch(
          () => {}
        );

        clearRoomRuntimeState(
          id
        );

        return;
      }

      const humans =
        humanMembers(
          channel
        );

      /*
       * Phòng đã trống:
       * không transfer.
       * Lifecycle delete xử lý.
       */
      if (
        humans.length ===
        0
      ) {
        await deleteOwnerAbsence(
          id
        ).catch(
          () => {}
        );

        cancelOwnerAbsenceTimer(
          id
        );

        scheduleEmptyRoomDelete(
          guild,
          id
        );

        return;
      }

      /*
       * Owner đã quay lại.
       */
      if (
        await ownerIsActuallyInRoom(
          guild,
          room
        )
      ) {
        await clearOwnerAbsenceBecauseReturned(
          channel,
          room,
          {
            notify:
              true
          }
        );

        return;
      }

      let absence =
        await getOwnerAbsence(
          id
        );

      /*
       * Không có record absence nữa:
       * không được tự transfer từ state mơ hồ.
       */
      if (!absence) {
        cancelOwnerAbsenceTimer(
          id
        );

        return;
      }

      /*
       * Owner DB đã đổi kể từ khi absence được tạo.
       */
      if (
        String(
          absence.owner_id
        ) !==
          String(
            room.owner_id
          )
      ) {
        await deleteOwnerAbsence(
          id
        ).catch(
          () => {}
        );

        cancelOwnerAbsenceTimer(
          id
        );

        return;
      }

      const deadline =
        new Date(
          absence.deadline_at
        ).getTime();

      /*
       * Timer chạy sớm hoặc startup recovery
       * khi deadline vẫn còn tương lai.
       */
      if (
        Number.isFinite(
          deadline
        ) &&
        deadline >
          Date.now() + 250
      ) {
        scheduleOwnerAbsenceTimer(
          guild,
          room,
          deadline
        );

        return;
      }

      const candidates =
        await getAutoTransferCandidates(
          guild,
          channel,
          room
        );

      /*
       * Không có người đủ điều kiện.
       * Giữ record absence và retry.
       * Không spam thêm countdown.
       */
      if (
        candidates.length ===
        0
      ) {
        await scheduleAutoTransferRetry(
          guild,
          id
        );

        return;
      }

      /*
       * Có thể candidate đầu tiên rời phòng
       * ngay lúc transfer.
       * Thử theo thứ tự presence.
       */
      for (
        const candidate
        of candidates
      ) {
        const result =
          await applyAutomaticOwnerTransfer(
            guild,
            channel,
            room,
            candidate.member
          );

        if (
          result.ok
        ) {
          await deleteAbsenceNotice(
            channel,
            absence
          );

          try {
            const message =
              await channel.send({
                content:
                  `🟢 <@${result.member.id}> đã trở thành chủ phòng mới.`
              });

            scheduleMessageDelete(
              message
            );
          } catch (_) {}

          return;
        }

        /*
         * Chủ cũ quay lại trong lúc xử lý.
         */
        if (
          result.reason ===
          'OWNER_RETURNED'
        ) {
          room =
            await getRoom(
              id
            ) || room;

          await clearOwnerAbsenceBecauseReturned(
            channel,
            room,
            {
              notify:
                true
            }
          );

          return;
        }

        /*
         * Một event khác đã đổi owner.
         */
        if (
          result.reason ===
          'OWNER_CHANGED'
        ) {
          await deleteOwnerAbsence(
            id
          ).catch(
            () => {}
          );

          cancelOwnerAbsenceTimer(
            id
          );

          return;
        }
      }

      /*
       * Tất cả candidate đều không còn hợp lệ.
       */
      await scheduleAutoTransferRetry(
        guild,
        id
      );
    }
  );
}


/* =========================================================
   P6 — SCHEDULE ABSENCE TIMER
   ========================================================= */

function scheduleOwnerAbsenceTimer(
  guild,
  room,
  deadlineInput
) {
  const channelId =
    String(
      room.channel_id
    );

  cancelOwnerAbsenceTimer(
    channelId
  );

  const deadline =
    deadlineInput instanceof Date
      ? deadlineInput.getTime()
      : Number(
          deadlineInput
        );

  const delay =
    Math.max(
      250,
      deadline -
      Date.now()
    );

  const timer =
    setTimeout(
      async () => {
        ownerAbsenceTimers.delete(
          channelId
        );

        try {
          await processOwnerAbsenceExpiry(
            guild,
            channelId
          );
        } catch (error) {
          logError(
            `OWNER_ABSENCE_EXPIRE:${channelId}`,
            error
          );
        }
      },
      delay
    );

  if (
    typeof timer.unref ===
    'function'
  ) {
    timer.unref();
  }

  ownerAbsenceTimers.set(
    channelId,
    timer
  );
}


/* =========================================================
   P6 — START OWNER ABSENCE
   ========================================================= */

async function startOwnerAbsence(
  guild,
  channel,
  room
) {
  if (
    !guild ||
    !channel ||
    !room
  ) {
    return;
  }

  /*
   * Phòng trống thì không tạo countdown.
   */
  if (
    humanMembers(
      channel
    ).length ===
    0
  ) {
    return;
  }

  /*
   * Actual voice state là nguồn quyết định.
   * Tránh false absence khi owner đang chuyển
   * từ generator sang temp room.
   */
  if (
    await ownerIsActuallyInRoom(
      guild,
      room
    )
  ) {
    return;
  }

  let absence =
    await getOwnerAbsence(
      channel.id
    );

  /*
   * Đã có countdown cho đúng owner:
   * không tạo message mới, không reset 10 phút.
   */
  if (
    absence &&
    String(
      absence.owner_id
    ) ===
      String(
        room.owner_id
      )
  ) {
    const deadline =
      new Date(
        absence.deadline_at
      ).getTime();

    scheduleOwnerAbsenceTimer(
      guild,
      room,
      Number.isFinite(
        deadline
      )
        ? deadline
        : Date.now()
    );

    return;
  }

  /*
   * Stale absence của owner cũ.
   */
  if (absence) {
    await deleteAbsenceNotice(
      channel,
      absence
    );

    await deleteOwnerAbsence(
      channel.id
    ).catch(
      () => {}
    );
  }

  const deadlineAt =
    new Date(
      Date.now() +
      OWNER_ABSENCE_GRACE_MS
    );

  const notice =
    await sendOwnerAbsenceNotice(
      channel,
      room.owner_id,
      deadlineAt
    );

  absence =
    await saveOwnerAbsence({
      channelId:
        channel.id,

      guildId:
        guild.id,

      ownerId:
        room.owner_id,

      deadlineAt,

      noticeMessageId:
        notice?.id ||
        null
    });

  scheduleOwnerAbsenceTimer(
    guild,
    room,
    new Date(
      absence.deadline_at
    ).getTime()
  );
}


/* =========================================================
   P6 — OWNER VOICE TRANSITION
   ========================================================= */

async function handleOwnerLifecycleTransition(
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

  if (
    setupCleanupGuilds.has(
      String(
        guild.id
      )
    )
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
   * -----------------------------------------------------
   * OWNER LEFT OLD ROOM
   * -----------------------------------------------------
   */

  if (oldChannelId) {
    const oldRoom =
      await getRoom(
        oldChannelId
      ).catch(
        () => null
      );

    if (
      oldRoom &&
      String(
        oldRoom.owner_id
      ) ===
        String(
          member.id
        )
    ) {
      /*
       * Chờ một chút để Discord voice state ổn định.
       * Điều này đặc biệt quan trọng khi bot vừa
       * move owner từ generator sang room.
       */
      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            350
          )
      );

      const channel =
        await fetchChannelSafe(
          guild,
          oldChannelId
        );

      if (channel) {
        const currentRoom =
          await getRoom(
            oldChannelId
          );

        if (
          currentRoom &&
          String(
            currentRoom.owner_id
          ) ===
            String(
              member.id
            )
        ) {
          const humans =
            humanMembers(
              channel
            );

          if (
            humans.length >
            0 &&
            !await ownerIsActuallyInRoom(
              guild,
              currentRoom
            )
          ) {
            await startOwnerAbsence(
              guild,
              channel,
              currentRoom
            );
          }
        }
      }
    }
  }

  /*
   * -----------------------------------------------------
   * OWNER ENTERED / RETURNED TO NEW ROOM
   * -----------------------------------------------------
   */

  if (newChannelId) {
    const newRoom =
      await getRoom(
        newChannelId
      ).catch(
        () => null
      );

    if (
      newRoom &&
      String(
        newRoom.owner_id
      ) ===
        String(
          member.id
        )
    ) {
      const channel =
        await fetchChannelSafe(
          guild,
          newChannelId
        );

      if (!channel) {
        return;
      }

      const absence =
        await getOwnerAbsence(
          newChannelId
        ).catch(
          () => null
        );

      if (
        absence &&
        String(
          absence.owner_id
        ) ===
          String(
            member.id
          )
      ) {
        await clearOwnerAbsenceBecauseReturned(
          channel,
          newRoom,
          {
            notify:
              true
          }
        );
      }
    }
  }
}


/* =========================================================
   P6 — START ABSENCE AFTER NON-OWNER LEAVES
   ========================================================= */

async function ensureOwnerAbsenceForOccupiedRoom(
  guild,
  channelId
) {
  const room =
    await getRoom(
      channelId
    );

  if (!room) {
    return;
  }

  const channel =
    await fetchChannelSafe(
      guild,
      channelId
    );

  if (!channel) {
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
    return;
  }

  if (
    await ownerIsActuallyInRoom(
      guild,
      room
    )
  ) {
    return;
  }

  await startOwnerAbsence(
    guild,
    channel,
    room
  );
}


/* =========================================================
   P6 — FULL VOICE LIFECYCLE WRAPPER
   ========================================================= */

async function handleVoiceStateLifecycle(
  oldState,
  newState
) {
  const guild =
    newState.guild ||
    oldState.guild;

  if (!guild) {
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
   * P5:
   * generator / presence / empty-room lifecycle.
   */
  await handleManagedVoiceTransition(
    oldState,
    newState
  );

  /*
   * P6:
   * owner grace lifecycle.
   */
  await handleOwnerLifecycleTransition(
    oldState,
    newState
  );

  /*
   * Nếu old room vẫn còn người nhưng owner
   * không còn ở đó, đảm bảo absence tồn tại.
   *
   * startOwnerAbsence tự chống duplicate.
   */
  if (oldChannelId) {
    await ensureOwnerAbsenceForOccupiedRoom(
      guild,
      oldChannelId
    ).catch(
      error => {
        logError(
          `ENSURE_OWNER_ABSENCE:${oldChannelId}`,
          error
        );
      }
    );
  }
}


/* =========================================================
   P6 — RECOVER OWNER ABSENCE AFTER RESTART
   ========================================================= */

async function recoverGuildOwnerAbsences(
  guild
) {
  if (!guild) {
    return;
  }

  const rooms =
    await getGuildRooms(
      guild.id
    );

  for (
    const room
    of rooms
  ) {
    const channel =
      await fetchChannelSafe(
        guild,
        room.channel_id
      );

    if (!channel) {
      continue;
    }

    const humans =
      humanMembers(
        channel
      );

    /*
     * Empty room để empty-room reconcile xử lý.
     */
    if (
      humans.length ===
      0
    ) {
      continue;
    }

    /*
     * Owner đang ở phòng:
     * stale absence phải được xóa.
     */
    if (
      await ownerIsActuallyInRoom(
        guild,
        room
      )
    ) {
      const absence =
        await getOwnerAbsence(
          channel.id
        ).catch(
          () => null
        );

      if (absence) {
        await deleteAbsenceNotice(
          channel,
          absence
        );

        await deleteOwnerAbsence(
          channel.id
        ).catch(
          () => {}
        );
      }

      cancelOwnerAbsenceTimer(
        channel.id
      );

      continue;
    }

    let absence =
      await getOwnerAbsence(
        channel.id
      ).catch(
        () => null
      );

    /*
     * Bot restart trong lúc owner đã rời
     * nhưng record chưa kịp tạo:
     * bắt đầu grace mới.
     */
    if (!absence) {
      await startOwnerAbsence(
        guild,
        channel,
        room
      );

      continue;
    }

    /*
     * Absence thuộc owner cũ.
     */
    if (
      String(
        absence.owner_id
      ) !==
        String(
          room.owner_id
        )
    ) {
      await deleteAbsenceNotice(
        channel,
        absence
      );

      await deleteOwnerAbsence(
        channel.id
      ).catch(
        () => {}
      );

      await startOwnerAbsence(
        guild,
        channel,
        room
      );

      continue;
    }

    const deadline =
      new Date(
        absence.deadline_at
      ).getTime();

    if (
      !Number.isFinite(
        deadline
      ) ||
      deadline <=
        Date.now()
    ) {
      /*
       * Deadline đã qua trong lúc bot offline.
       */
      await processOwnerAbsenceExpiry(
        guild,
        channel.id
      );

      continue;
    }

    /*
     * Resume timer với deadline cũ,
     * không reset thêm 10 phút.
     */
    scheduleOwnerAbsenceTimer(
      guild,
      room,
      deadline
    );
  }
}


/* =========================================================
   P6 — /CLAIM ELIGIBILITY
   ========================================================= */

async function getClaimContext(
  interaction
) {
  if (
    !interaction.inGuild()
  ) {
    return {
      ok:
        false,

      reason:
        'GUILD_ONLY'
    };
  }

  const member =
    await fetchMemberWithVoiceState(
      interaction.guild,
      interaction.user.id
    );

  if (!member) {
    return {
      ok:
        false,

      reason:
        'MEMBER_MISSING'
    };
  }

  const channelId =
    getMemberVoiceChannelId(
      member
    );

  if (!channelId) {
    return {
      ok:
        false,

      reason:
        'NOT_IN_VOICE'
    };
  }

  const room =
    await getRoom(
      channelId
    );

  if (!room) {
    return {
      ok:
        false,

      reason:
        'NOT_MANAGED_ROOM'
    };
  }

  const channel =
    await fetchChannelSafe(
      interaction.guild,
      channelId
    );

  if (!channel) {
    return {
      ok:
        false,

      reason:
        'ROOM_MISSING'
    };
  }

  if (
    String(
      room.owner_id
    ) ===
      String(
        interaction.user.id
      )
  ) {
    return {
      ok:
        false,

      reason:
        'ALREADY_OWNER'
    };
  }

  /*
   * Exact-room validation.
   */
  if (
    !await memberIsInExactRoom(
      interaction.guild,
      interaction.user.id,
      channel.id
    )
  ) {
    return {
      ok:
        false,

      reason:
        'NOT_IN_ROOM'
    };
  }

  /*
   * Chủ vẫn đang ở room thì không claim.
   */
  if (
    await ownerIsActuallyInRoom(
      interaction.guild,
      room
    )
  ) {
    return {
      ok:
        false,

      reason:
        'OWNER_PRESENT'
    };
  }

  const absence =
    await getOwnerAbsence(
      channel.id
    );

  if (absence) {
    const deadline =
      new Date(
        absence.deadline_at
      ).getTime();

    /*
     * Grace 10 phút chưa hết:
     * /claim bị chặn.
     */
    if (
      Number.isFinite(
        deadline
      ) &&
      deadline >
        Date.now()
    ) {
      return {
        ok:
          false,

        reason:
          'GRACE_ACTIVE',

        deadline
      };
    }
  }

  /*
   * Người claim không được sở hữu room khác.
   */
  const owned =
    await getOwnedRoom(
      interaction.guildId,
      interaction.user.id
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
    return {
      ok:
        false,

      reason:
        'OWNS_OTHER_ROOM'
    };
  }

  return {
    ok:
      true,

    room,
    channel,
    member
  };
}


/* =========================================================
   P6 — /CLAIM
   ========================================================= */

async function handleClaimCommand(
  interaction
) {
  await interaction.deferReply({
    flags:
      MessageFlags.Ephemeral
  });

  const context =
    await getClaimContext(
      interaction
    );

  if (!context.ok) {
    let text;

    switch (
      context.reason
    ) {
      case 'NOT_IN_VOICE':
        text =
          'Bạn cần ở trong một phòng Voice HDK.';
        break;

      case 'NOT_MANAGED_ROOM':
        text =
          'Phòng hiện tại không phải phòng Voice HDK.';
        break;

      case 'ALREADY_OWNER':
        text =
          'Bạn đang là chủ phòng này.';
        break;

      case 'OWNER_PRESENT':
        text =
          'Chủ phòng hiện vẫn đang ở trong phòng.';
        break;

      case 'GRACE_ACTIVE':
        text =
          `Chủ phòng vẫn đang trong thời gian quay lại. Có thể xử lý sau <t:${Math.floor(
            context.deadline /
            1000
          )}:R>.`;
        break;

      case 'OWNS_OTHER_ROOM':
        text =
          'Bạn đang sở hữu một phòng Voice HDK khác.';
        break;

      default:
        text =
          'Hiện không thể nhận quyền chủ phòng.';
        break;
    }

    await interaction.editReply({
      content:
        buildNoticeText(
          text,
          'warning'
        )
    });

    scheduleOriginalReplyDelete(
      interaction
    );

    return;
  }

  /*
   * /claim sau grace vẫn không được tùy tiện
   * cướp quyền khỏi người ở lâu hơn.
   *
   * Dùng cùng nguyên tắc auto-transfer:
   * người hợp lệ ở lâu nhất được ưu tiên.
   */
  const candidates =
    await getAutoTransferCandidates(
      interaction.guild,
      context.channel,
      context.room
    );

  const first =
    candidates[0];

  if (!first) {
    await interaction.editReply({
      content:
        buildNoticeText(
          'Hiện chưa có thành viên đủ điều kiện nhận quyền chủ.',
          'warning'
        )
    });

    scheduleOriginalReplyDelete(
      interaction
    );

    return;
  }

  if (
    String(
      first.member.id
    ) !==
      String(
        interaction.user.id
      )
  ) {
    await interaction.editReply({
      content:
        buildNoticeText(
          `${first.member.displayName} đang là thành viên đủ điều kiện ở phòng lâu hơn.`,
          'warning'
        )
    });

    scheduleOriginalReplyDelete(
      interaction
    );

    return;
  }

  const result =
    await applyAutomaticOwnerTransfer(
      interaction.guild,
      context.channel,
      context.room,
      context.member
    );

  if (!result.ok) {
    await interaction.editReply({
      content:
        buildNoticeText(
          'Không thể nhận quyền chủ phòng lúc này.',
          'error'
        )
    });

    scheduleOriginalReplyDelete(
      interaction
    );

    return;
  }

  const absence =
    await getOwnerAbsence(
      context.channel.id
    ).catch(
      () => null
    );

  if (absence) {
    await deleteAbsenceNotice(
      context.channel,
      absence
    );
  }

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


/* =========================================================
   P6 — CLAIM COMMAND DEFINITION
   ========================================================= */

const claimCommand =
  new SlashCommandBuilder()
    .setName(
      'claim'
    )
    .setDescription(
      'Nhận quyền chủ phòng khi chủ cũ không còn ở phòng'
    );


/* =========================================================
   P6 — RECOVER PRESENCE
   ========================================================= */

async function recoverGuildRoomPresence(
  guild
) {
  const rooms =
    await getGuildRooms(
      guild.id
    );

  for (
    const room
    of rooms
  ) {
    const channel =
      await fetchChannelSafe(
        guild,
        room.channel_id
      );

    if (
      !channel ||
      !isVoiceChannel(
        channel
      )
    ) {
      continue;
    }

    await syncRoomPresence(
      channel,
      room
    );
  }
}


/* =========================================================
   P6 — RECOVER EMPTY ROOMS
   ========================================================= */

async function recoverGuildEmptyRooms(
  guild
) {
  const rooms =
    await getGuildRooms(
      guild.id
    );

  for (
    const room
    of rooms
  ) {
    const channel =
      await fetchChannelSafe(
        guild,
        room.channel_id
      );

    /*
     * Discord room đã mất.
     */
    if (!channel) {
      await deleteRoomRecord(
        room.channel_id
      ).catch(
        error => {
          logError(
            `RECOVER_STALE_ROOM:${room.channel_id}`,
            error
          );
        }
      );

      clearRoomRuntimeState(
        room.channel_id
      );

      continue;
    }

    const humans =
      humanMembers(
        channel
      );

    if (
      humans.length ===
      0
    ) {
      scheduleEmptyRoomDelete(
        guild,
        channel.id
      );
    } else {
      cancelEmptyRoomDelete(
        channel.id
      );
    }
  }
}


/* =========================================================
   P6 — RECOVER PANELS
   ========================================================= */

async function recoverGuildRoomPanels(
  guild
) {
  const rooms =
    await getGuildRooms(
      guild.id
    );

  for (
    const room
    of rooms
  ) {
    const channel =
      await fetchChannelSafe(
        guild,
        room.channel_id
      );

    if (
      !channel ||
      !isVoiceChannel(
        channel
      )
    ) {
      continue;
    }

    await ensureOwnerDirectPermissions(
      channel,
      room.owner_id
    ).catch(
      () => {}
    );

    await ensureRoomPanel(
      channel,
      room,
      room.owner_id
    ).catch(
      error => {
        logError(
          `RECOVER_PANEL:${channel.id}`,
          error
        );
      }
    );
  }
}


/* =========================================================
   P6 — GUILD ROOM RUNTIME RECOVERY
   ========================================================= */

async function recoverGuildRoomRuntime(
  guild
) {
  /*
   * Thứ tự:
   * 1. presence
   * 2. empty rooms
   * 3. panels
   * 4. owner absence
   */

  await recoverGuildRoomPresence(
    guild
  );

  await recoverGuildEmptyRooms(
    guild
  );

  await recoverGuildRoomPanels(
    guild
  );

  await recoverGuildOwnerAbsences(
    guild
  );
}
/* =========================================================
   P7.1 — SETUP SESSION
   ========================================================= */

function setupSessionKey(guildId, userId) {
  return `${String(guildId)}:${String(userId)}`;
}

function clearSetupSession(guildId, userId) {
  const key = setupSessionKey(guildId, userId);
  const session = setupSessions.get(key);

  if (session?.timer) {
    clearTimeout(session.timer);
  }

  setupSessions.delete(key);
}

function setSetupSession(guildId, userId) {
  clearSetupSession(guildId, userId);

  const key = setupSessionKey(guildId, userId);

  const session = {
    guildId: String(guildId),
    userId: String(userId),
    buttonCategoryId: null,
    blogCategoryId: null,
    createdAt: Date.now(),
    timer: null
  };

  const timer = setTimeout(() => {
    const current = setupSessions.get(key);

    if (current === session) {
      setupSessions.delete(key);
    }
  }, SETUP_TIMEOUT_MS);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  session.timer = timer;

  setupSessions.set(key, session);

  return session;
}

function getSetupSession(guildId, userId) {
  return (
    setupSessions.get(
      setupSessionKey(guildId, userId)
    ) || null
  );
}

function updateSetupSession(guildId, userId, patch) {
  const session = getSetupSession(guildId, userId);

  if (!session) {
    return null;
  }

  Object.assign(session, patch || {});

  return session;
}


/* =========================================================
   P7.1 — SETUP PERMISSION
   ========================================================= */

async function userCanManageSetup(interaction) {
  if (!interaction.inGuild()) {
    return false;
  }

  const member = await fetchMemberSafe(
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

async function inspectSetupBotPermissions(guild) {
  const me =
    guild.members.me ||
    await fetchMemberSafe(
      guild,
      client.user.id
    );

  if (!me) {
    return {
      ok: false,
      missing: [
        'Không lấy được thông tin bot'
      ]
    };
  }

  const checks = [
    [
      PermissionsBitField.Flags.ViewChannel,
      'Xem kênh'
    ],
    [
      PermissionsBitField.Flags.SendMessages,
      'Gửi tin nhắn'
    ],
    [
      PermissionsBitField.Flags.EmbedLinks,
      'Nhúng liên kết'
    ],
    [
      PermissionsBitField.Flags.ReadMessageHistory,
      'Đọc lịch sử tin nhắn'
    ],
    [
      PermissionsBitField.Flags.ManageChannels,
      'Quản lý kênh'
    ],
    [
      PermissionsBitField.Flags.ManageRoles,
      'Quản lý vai trò/quyền kênh'
    ],
    [
      PermissionsBitField.Flags.MoveMembers,
      'Di chuyển thành viên'
    ],
    [
      PermissionsBitField.Flags.Connect,
      'Kết nối'
    ]
  ];

  const missing = [];

  for (const [permission, label] of checks) {
    if (!me.permissions.has(permission)) {
      missing.push(label);
    }
  }

  return {
    ok: missing.length === 0,
    missing
  };
}

function setupPermissionErrorText(result) {
  if (!result?.missing?.length) {
    return '';
  }

  return (
    'Thiếu quyền: ' +
    result.missing.join(', ')
  );
}


/* =========================================================
   P7.1 — SETUP HOME UI
   ========================================================= */

function buildSetupHomeEmbed(guild) {
  return new EmbedBuilder()
    .setColor(UI_COLORS.blue)
    .setTitle(
      '⚙️ Voice HDK • Quản lý hệ thống'
    )
    .setDescription(
      [
        `Server: **${cleanDisplayName(guild?.name) || 'Không xác định'}**`,
        '',
        '**Cài đặt / Cài đặt lại**',
        'Chọn danh mục phòng thoại, danh mục nhật ký và đặt tên hiển thị cho Voice HDK.',
        '',
        '**Xóa toàn bộ Voice HDK**',
        'Xóa các kênh và dữ liệu mà Voice HDK đang quản lý trên Server này.',
        '',
        'Các Category Discord bạn chọn sẽ **không bị xóa**.'
      ].join('\n')
    );
}

function buildSetupHomeComponents() {
  return [
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('setup_install')
          .setLabel('Cài đặt / Cài đặt lại')
          .setEmoji('⚙️')
          .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
          .setCustomId('setup_uninstall')
          .setLabel('Xóa toàn bộ Voice HDK')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger)
      )
  ];
}


/* =========================================================
   P7.1 — CATEGORY SELECTION UI
   ========================================================= */

function buildSetupCategoryEmbed() {
  return new EmbedBuilder()
    .setColor(UI_COLORS.blue)
    .setTitle(
      '⚙️ Cài đặt Voice HDK'
    )
    .setDescription(
      [
        '**Bước 1 — Danh mục phòng thoại**',
        `Chọn Category nơi đặt **${CREATE_VOICE_NAME}** và các phòng tạm.`,
        '',
        '**Bước 2 — Danh mục nhật ký**',
        `Chọn Category nơi đặt **${CHAT_LOG_CHANNEL_NAME}** và **${ACTION_LOG_CHANNEL_NAME}**.`,
        '',
        '**Bước 3 — Tiếp tục**',
        'Sau khi chọn đủ hai danh mục, nhấn **Tiếp tục** để đặt tên hiển thị Server.',
        '',
        'Voice HDK không xóa hai Category bạn chọn.'
      ].join('\n')
    );
}

function buildSetupCategoryComponents(session) {
  const voiceCategory =
    new ChannelSelectMenuBuilder()
      .setCustomId('setup_button_category')
      .setPlaceholder(
        session?.buttonCategoryId
          ? 'Đã chọn danh mục phòng thoại'
          : 'Chọn danh mục phòng thoại'
      )
      .setChannelTypes(
        ChannelType.GuildCategory
      )
      .setMinValues(1)
      .setMaxValues(1);

  const logCategory =
    new ChannelSelectMenuBuilder()
      .setCustomId('setup_blog_category')
      .setPlaceholder(
        session?.blogCategoryId
          ? 'Đã chọn danh mục nhật ký'
          : 'Chọn danh mục nhật ký'
      )
      .setChannelTypes(
        ChannelType.GuildCategory
      )
      .setMinValues(1)
      .setMaxValues(1);

  const ready = Boolean(
    session?.buttonCategoryId &&
    session?.blogCategoryId
  );

  return [
    new ActionRowBuilder()
      .addComponents(voiceCategory),

    new ActionRowBuilder()
      .addComponents(logCategory),

    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('setup_continue')
          .setLabel('Tiếp tục')
          .setEmoji('➡️')
          .setStyle(ButtonStyle.Success)
          .setDisabled(!ready),

        new ButtonBuilder()
          .setCustomId('setup_cancel')
          .setLabel('Hủy')
          .setStyle(ButtonStyle.Secondary)
      )
  ];
}


/* =========================================================
   P7.1 — UNINSTALL CONFIRM UI
   ========================================================= */

function buildUninstallConfirmEmbed() {
  return new EmbedBuilder()
    .setColor(UI_COLORS.orange)
    .setTitle(
      '🗑️ Xóa toàn bộ Voice HDK?'
    )
    .setDescription(
      [
        'Thao tác này sẽ xóa các tài nguyên Voice HDK đang quản lý trên Server này:',
        '',
        `• ${CREATE_VOICE_NAME}`,
        '• Toàn bộ phòng tạm Voice HDK',
        `• ${CHAT_LOG_CHANNEL_NAME}`,
        `• ${ACTION_LOG_CHANNEL_NAME}`,
        '• Panel và dữ liệu phòng',
        '• Dữ liệu mời / cấm',
        '• Dữ liệu chủ phòng',
        '• Dữ liệu chuyển chủ / vắng mặt',
        '• Cấu hình Voice HDK của Server trong PostgreSQL',
        '',
        '**Không xóa Category Discord đã chọn.**',
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
          .setLabel('Xác nhận xóa')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger),

        new ButtonBuilder()
          .setCustomId(
            'setup_uninstall_cancel'
          )
          .setLabel('Không xóa')
          .setEmoji('↩️')
          .setStyle(ButtonStyle.Primary)
      )
  ];
}


/* =========================================================
   P7.1 — /SETUP COMMAND
   ========================================================= */

const setupCommand =
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription(
      'Cài đặt và quản lý Voice HDK'
    );

const panelCommand =
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription(
      'Kiểm tra và khôi phục panel phòng Voice HDK'
    );


/* =========================================================
   P7.1 — SETUP COMMAND HANDLER
   ========================================================= */

async function handleSetupCommand(interaction) {
  if (!interaction.inGuild()) {
    return tempReply(
      interaction,
      'Lệnh này chỉ sử dụng trong Server.',
      'warning'
    );
  }

  const allowed =
    await userCanManageSetup(interaction);

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
    flags:
      MessageFlags.Ephemeral
  });
}


/* =========================================================
   P7.1 — INSTALL BUTTON
   ========================================================= */

async function handleSetupInstallButton(
  interaction
) {
  const allowed =
    await userCanManageSetup(interaction);

  if (!allowed) {
    return tempInteractionNotice(
      interaction,
      'Bạn không có quyền cài đặt Voice HDK.',
      'warning'
    );
  }

  const permissions =
    await inspectSetupBotPermissions(
      interaction.guild
    );

  if (!permissions.ok) {
    return tempInteractionNotice(
      interaction,
      [
        'Bot đang thiếu quyền cần thiết.',
        setupPermissionErrorText(
          permissions
        )
      ].join('\n'),
      'error'
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


/* =========================================================
   P7.1 — VOICE CATEGORY SELECT
   ========================================================= */

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

  if (!isCategoryChannel(category)) {
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


/* =========================================================
   P7.1 — LOG CATEGORY SELECT
   ========================================================= */

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

  if (!isCategoryChannel(category)) {
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


/* =========================================================
   P7.1 — CONTINUE -> DISPLAY NAME MODAL
   ========================================================= */

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

  const voiceCategory =
    await fetchChannelSafe(
      interaction.guild,
      session.buttonCategoryId
    );

  const logCategory =
    await fetchChannelSafe(
      interaction.guild,
      session.blogCategoryId
    );

  if (
    !isCategoryChannel(
      voiceCategory
    ) ||
    !isCategoryChannel(
      logCategory
    )
  ) {
    clearSetupSession(
      interaction.guildId,
      interaction.user.id
    );

    return tempInteractionNotice(
      interaction,
      'Một danh mục đã bị xóa hoặc không còn hợp lệ. Hãy /setup lại.',
      'error'
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
      .addComponents(input)
  );

  await interaction.showModal(
    modal
  );
}


/* =========================================================
   P7.1 — CANCEL SETUP
   ========================================================= */

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


/* =========================================================
   P7.1 — TRACKED CHANNEL LIST
   ========================================================= */

function uniqueTrackedChannelIds(
  generator,
  rooms
) {
  const ids = new Set();

  for (const room of rooms) {
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

  const extraIds = [
    generator?.create_voice_id,
    generator?.chat_log_channel_id,
    generator?.action_log_channel_id
  ];

  for (const id of extraIds) {
    if (isSnowflake(id)) {
      ids.add(String(id));
    }
  }

  return [...ids];
}


/* =========================================================
   P7.1 — DELETE TRACKED CHANNELS
   ========================================================= */

async function deleteTrackedManagedChannels(
  guild,
  channelIds
) {
  const failed = [];

  for (const channelId of channelIds) {
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
        String(channelId)
      );
    }
  }

  return failed;
}


/* =========================================================
   P7.1 — DELETE GUILD DB CONFIG
   ========================================================= */

async function deleteGuildDatabaseConfiguration(
  guildId
) {
  const db =
    await pool.connect();

  try {
    await db.query('BEGIN');

    await deleteGuildVoiceData(
      guildId,
      db
    );

    await deleteGenerator(
      guildId,
      db
    );

    await db.query('COMMIT');

    return true;
  } catch (error) {
    await db.query(
      'ROLLBACK'
    ).catch(() => {});

    logError(
      'DELETE_GUILD_DATABASE',
      error
    );

    return false;
  } finally {
    db.release();
  }
}


/* =========================================================
   P7.1 — CLEANUP MANAGED GUILD
   ========================================================= */

async function cleanupManagedGuild(
  guild
) {
  const guildId =
    String(guild.id);

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

    for (const room of rooms) {
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

    /*
     * Nếu Discord còn channel chưa xóa được,
     * giữ nguyên DB để bot không mất dấu.
     */
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
  } finally {
    setupCleanupGuilds.delete(
      guildId
    );
  }
}


/* =========================================================
   P7.1 — ROLLBACK NEW SETUP CHANNELS
   ========================================================= */

async function rollbackNewSetupChannels(
  channels
) {
  for (
    const channel
    of [...channels].reverse()
  ) {
    if (!channel) {
      continue;
    }

    await safeDeleteChannel(
      channel,
      `${BOT_NAME} rollback cài đặt`
    );
  }
}


/* =========================================================
   P7.1 — INSTALL VOICE HDK
   ========================================================= */

async function installVoiceHDK(
  guild,
  buttonCategory,
  blogCategory,
  displayName
) {
  const guildId =
    String(guild.id);

  if (
    setupCleanupGuilds.has(
      guildId
    )
  ) {
    return {
      ok: false,
      reason: 'BUSY'
    };
  }

  const permissions =
    await inspectSetupBotPermissions(
      guild
    );

  if (!permissions.ok) {
    return {
      ok: false,
      reason: 'PERMISSIONS',
      permissions
    };
  }

  if (
    !isCategoryChannel(
      buttonCategory
    ) ||
    !isCategoryChannel(
      blogCategory
    )
  ) {
    return {
      ok: false,
      reason: 'CATEGORY_INVALID'
    };
  }

  /*
   * Cài lại = dọn sạch tài nguyên Voice HDK cũ
   * trước khi tạo hệ thống mới.
   */
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
        cleanup.failedChannelIds || []
    };
  }

  /*
   * cleanupManagedGuild vừa nhả guard.
   * Bắt đầu guard riêng cho quá trình create.
   */
  setupCleanupGuilds.add(
    guildId
  );

  const created = [];

  try {
    const generatorChannel =
      await guild.channels.create({
        name:
          CREATE_VOICE_NAME,

        type:
          ChannelType.GuildVoice,

        parent:
          buttonCategory.id,

        reason:
          `${BOT_NAME} cài đặt generator`
      });

    created.push(
      generatorChannel
    );

    const chatLogChannel =
      await guild.channels.create({
        name:
          CHAT_LOG_CHANNEL_NAME,

        type:
          ChannelType.GuildText,

        parent:
          blogCategory.id,

        reason:
          `${BOT_NAME} tạo nhật ký chat`
      });

    created.push(
      chatLogChannel
    );

    const actionLogChannel =
      await guild.channels.create({
        name:
          ACTION_LOG_CHANNEL_NAME,

        type:
          ChannelType.GuildText,

        parent:
          blogCategory.id,

        reason:
          `${BOT_NAME} tạo nhật ký chức năng`
      });

    created.push(
      actionLogChannel
    );

    await saveGenerator({
      guildId,
      displayName:
        cleanDisplayName(
          displayName
        ),
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

    try {
      await generatorChannel.setPosition(
        0,
        {
          reason:
            `${BOT_NAME} đặt generator lên đầu`
        }
      );
    } catch (error) {
      logError(
        `SETUP_GENERATOR_POSITION:${guildId}`,
        error
      );
    }

    return {
      ok: true,
      generatorChannel,
      chatLogChannel,
      actionLogChannel
    };
  } catch (error) {
    logError(
      `INSTALL_VOICE_HDK:${guildId}`,
      error
    );

    await rollbackNewSetupChannels(
      created
    );

    await deleteGuildDatabaseConfiguration(
      guildId
    ).catch(() => {});

    return {
      ok: false,
      reason: 'INSTALL_FAILED'
    };
  } finally {
    setupCleanupGuilds.delete(
      guildId
    );
  }
}


/* =========================================================
   P7.1 — DISPLAY NAME MODAL SUBMIT
   ========================================================= */

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
      interaction.fields
        .getTextInputValue(
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
    flags:
      MessageFlags.Ephemeral
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
      message = [
        'Bot đang thiếu quyền cần thiết.',
        setupPermissionErrorText(
          result.permissions
        )
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
          ? `Không thể xóa ${result.failedChannelIds.length} kênh Voice HDK cũ. Bot đã dừng cài lại để tránh mất dấu dữ liệu.`
          : 'Không thể dọn sạch cấu hình Voice HDK cũ.';
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
    content: [
      '🟢 **Cài đặt Voice HDK thành công.**',
      '',
      `🔊 ${CREATE_VOICE_NAME}`,
      `💬 ${CHAT_LOG_CHANNEL_NAME}`,
      `⚙️ ${ACTION_LOG_CHANNEL_NAME}`,
      '',
      `🏷️ Tên hiển thị: **${displayName}**`,
      '',
      '**Huỳnh Duy Khánh / 0988850044**'
    ].join('\n')
  });

  scheduleOriginalReplyDelete(
    interaction
  );
}


/* =========================================================
   P7.1 — UNINSTALL BUTTON
   ========================================================= */

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

    if (result.busy) {
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
/* =========================================================
   P7.2 — CHAT LOG HELPERS
   ========================================================= */

function messageLogTimestamp(date = new Date()) {
  return vietnamTime(date);
}

function messageAuthorText(message) {
  if (!message?.author) {
    return 'Không xác định';
  }

  return (
    `${message.author.tag || message.author.username}` +
    ` (${message.author.id})`
  );
}

function messageChannelText(message) {
  if (!message?.channel) {
    return 'Không xác định';
  }

  return (
    `#${message.channel.name || 'channel'}` +
    ` (${message.channel.id})`
  );
}

function extractMessageLinks(content) {
  const text =
    String(content || '');

  const matches =
    text.match(
      /https?:\/\/[^\s<]+/gi
    ) || [];

  return [
    ...new Set(matches)
  ];
}

function attachmentMetadataText(attachment) {
  if (!attachment) {
    return '';
  }

  const size =
    Number(
      attachment.size || 0
    );

  return [
    `Tên: ${attachment.name || 'Không rõ'}`,
    `Dung lượng: ${size.toLocaleString('vi-VN')} bytes`,
    `URL: ${attachment.url || 'Không có'}`
  ].join('\n');
}

async function getChatLogChannel(guild) {
  if (!guild) {
    return null;
  }

  const generator =
    await getGenerator(
      guild.id
    ).catch(
      () => null
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
    !channel ||
    !isTextChannel(
      channel
    )
  ) {
    return null;
  }

  return channel;
}

async function sendChatLogPayload(
  guild,
  payload
) {
  const channel =
    await getChatLogChannel(
      guild
    );

  if (!channel) {
    return null;
  }

  try {
    return await channel.send(
      payload
    );
  } catch (error) {
    logError(
      `CHAT_LOG_SEND:${guild.id}`,
      error
    );

    return null;
  }
}


/* =========================================================
   P7.2 — ATTACHMENT ARCHIVE
   ========================================================= */

async function downloadAttachmentBuffer(
  attachment
) {
  if (
    !attachment?.url
  ) {
    return null;
  }

  /*
   * Tránh cố tải file quá lớn vào RAM.
   * Nếu vượt giới hạn này, log metadata + URL.
   */
  const MAX_ARCHIVE_BYTES =
    20 * 1024 * 1024;

  const knownSize =
    Number(
      attachment.size || 0
    );

  if (
    knownSize >
    MAX_ARCHIVE_BYTES
  ) {
    return null;
  }

  try {
    const response =
      await fetch(
        attachment.url
      );

    if (!response.ok) {
      return null;
    }

    const length =
      Number(
        response.headers.get(
          'content-length'
        ) || 0
      );

    if (
      length >
      MAX_ARCHIVE_BYTES
    ) {
      return null;
    }

    const arrayBuffer =
      await response.arrayBuffer();

    const buffer =
      Buffer.from(
        arrayBuffer
      );

    if (
      buffer.length >
      MAX_ARCHIVE_BYTES
    ) {
      return null;
    }

    return buffer;
  } catch (error) {
    logError(
      `ATTACHMENT_DOWNLOAD:${attachment.id || 'unknown'}`,
      error
    );

    return null;
  }
}

async function archiveMessageAttachments(
  logChannel,
  message
) {
  if (
    !logChannel ||
    !message?.attachments?.size
  ) {
    return;
  }

  for (
    const attachment
    of message.attachments.values()
  ) {
    const buffer =
      await downloadAttachmentBuffer(
        attachment
      );

    if (buffer) {
      try {
        await logChannel.send({
          content: [
            '📎 **Tệp đính kèm đã lưu**',
            `Tác giả: ${messageAuthorText(message)}`,
            `Kênh: ${messageChannelText(message)}`,
            `Thời gian: ${messageLogTimestamp(message.createdAt || new Date())}`,
            '',
            attachmentMetadataText(
              attachment
            )
          ].join('\n'),

          files: [
            {
              attachment:
                buffer,

              name:
                attachment.name ||
                `attachment-${attachment.id || Date.now()}`
            }
          ]
        });

        continue;
      } catch (error) {
        logError(
          `ATTACHMENT_ARCHIVE:${message.id}:${attachment.id}`,
          error
        );
      }
    }

    /*
     * Không tải được hoặc quá lớn:
     * vẫn giữ metadata + URL.
     */
    try {
      await logChannel.send({
        content: [
          '⚠️ **Không thể lưu trực tiếp tệp đính kèm**',
          `Tác giả: ${messageAuthorText(message)}`,
          `Kênh: ${messageChannelText(message)}`,
          '',
          attachmentMetadataText(
            attachment
          )
        ].join('\n')
      });
    } catch (_) {}
  }
}


/* =========================================================
   P7.2 — MESSAGE CREATE LOG
   ========================================================= */

async function logCreatedMessage(
  message
) {
  if (
    !message ||
    !message.guild ||
    message.author?.bot
  ) {
    return;
  }

  const logChannel =
    await getChatLogChannel(
      message.guild
    );

  if (!logChannel) {
    return;
  }

  /*
   * Không log chính channel nhật ký
   * để tránh vòng lặp.
   */
  if (
    String(
      message.channelId
    ) ===
      String(
        logChannel.id
      )
  ) {
    return;
  }

  const content =
    truncateLogText(
      message.content ||
      '(Không có nội dung chữ)',
      1800
    );

  const links =
    extractMessageLinks(
      message.content
    );

  const lines = [
    '💬 **TIN NHẮN MỚI**',
    `Người gửi: ${messageAuthorText(message)}`,
    `Kênh: ${messageChannelText(message)}`,
    `Thời gian: ${messageLogTimestamp(message.createdAt || new Date())}`,
    `Message ID: ${message.id}`,
    '',
    '**Nội dung:**',
    content
  ];

  if (
    links.length >
    0
  ) {
    lines.push(
      '',
      '**Liên kết:**',
      truncateLogText(
        links.join('\n'),
        1000
      )
    );
  }

  if (
    message.attachments?.size
  ) {
    lines.push(
      '',
      `**Tệp đính kèm:** ${message.attachments.size}`
    );
  }

  try {
    await logChannel.send({
      content:
        truncateLogText(
          lines.join('\n'),
          1950
        )
    });
  } catch (error) {
    logError(
      `MESSAGE_CREATE_LOG:${message.id}`,
      error
    );
  }

  await archiveMessageAttachments(
    logChannel,
    message
  );
}


/* =========================================================
   P7.2 — MESSAGE UPDATE LOG
   ========================================================= */

async function logEditedMessage(
  oldMessage,
  newMessage
) {
  if (
    !newMessage?.guild
  ) {
    return;
  }

  try {
    if (
      newMessage.partial
    ) {
      newMessage =
        await newMessage.fetch();
    }
  } catch (_) {}

  if (
    newMessage.author?.bot
  ) {
    return;
  }

  const oldContent =
    String(
      oldMessage?.content || ''
    );

  const newContent =
    String(
      newMessage?.content || ''
    );

  if (
    oldContent ===
      newContent
  ) {
    return;
  }

  const logChannel =
    await getChatLogChannel(
      newMessage.guild
    );

  if (!logChannel) {
    return;
  }

  if (
    String(
      newMessage.channelId
    ) ===
      String(
        logChannel.id
      )
  ) {
    return;
  }

  const lines = [
    '✏️ **TIN NHẮN ĐÃ SỬA**',
    `Người gửi: ${messageAuthorText(newMessage)}`,
    `Kênh: ${messageChannelText(newMessage)}`,
    `Thời gian: ${messageLogTimestamp(new Date())}`,
    `Message ID: ${newMessage.id}`,
    '',
    '**Trước:**',
    truncateLogText(
      oldContent ||
      '(Không lấy được nội dung cũ)',
      750
    ),
    '',
    '**Sau:**',
    truncateLogText(
      newContent ||
      '(Nội dung trống)',
      750
    )
  ];

  try {
    await logChannel.send({
      content:
        truncateLogText(
          lines.join('\n'),
          1950
        )
    });
  } catch (error) {
    logError(
      `MESSAGE_UPDATE_LOG:${newMessage.id}`,
      error
    );
  }
}


/* =========================================================
   P7.2 — MESSAGE DELETE LOG
   ========================================================= */

async function logDeletedMessage(
  message
) {
  if (
    !message?.guild
  ) {
    return;
  }

  if (
    message.author?.bot
  ) {
    return;
  }

  const logChannel =
    await getChatLogChannel(
      message.guild
    );

  if (!logChannel) {
    return;
  }

  if (
    String(
      message.channelId
    ) ===
      String(
        logChannel.id
      )
  ) {
    return;
  }

  const content =
    truncateLogText(
      message.content ||
      '(Không lấy được nội dung đã xóa)',
      1500
    );

  const lines = [
    '🗑️ **TIN NHẮN ĐÃ XÓA**',
    `Người gửi: ${messageAuthorText(message)}`,
    `Kênh: ${messageChannelText(message)}`,
    `Thời gian: ${messageLogTimestamp(new Date())}`,
    `Message ID: ${message.id || 'Không xác định'}`,
    '',
    '**Nội dung:**',
    content
  ];

  if (
    message.attachments?.size
  ) {
    lines.push(
      '',
      '**Tệp đính kèm:**'
    );

    for (
      const attachment
      of message.attachments.values()
    ) {
      lines.push(
        truncateLogText(
          attachmentMetadataText(
            attachment
          ),
          500
        )
      );
    }
  }

  try {
    await logChannel.send({
      content:
        truncateLogText(
          lines.join('\n'),
          1950
        )
    });
  } catch (error) {
    logError(
      `MESSAGE_DELETE_LOG:${message.id || 'unknown'}`,
      error
    );
  }
}


/* =========================================================
   P7.2 — /PANEL
   ========================================================= */

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

  const member =
    await fetchMemberWithVoiceState(
      interaction.guild,
      interaction.user.id
    );

  if (!member) {
    return tempReply(
      interaction,
      'Không thể lấy thông tin thành viên.',
      'error'
    );
  }

  const voiceChannelId =
    getMemberVoiceChannelId(
      member
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

  const channel =
    await fetchChannelSafe(
      interaction.guild,
      voiceChannelId
    );

  if (!channel) {
    return tempReply(
      interaction,
      'Không tìm thấy phòng.',
      'error'
    );
  }

  await interaction.deferReply({
    flags:
      MessageFlags.Ephemeral
  });

  const panel =
    await ensureRoomPanel(
      channel,
      room,
      interaction.user.id
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
   P7.2 — INTERACTION ROUTER
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

  /*
   * Transfer buttons chứa channel ID.
   */
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

  switch (customId) {
    /*
     * SETUP
     */
    case 'setup_install':
      return handleSetupInstallButton(
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

    /*
     * ROOM PANEL
     */
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
   P7.2 — TOP-LEVEL INTERACTION ERROR
   ========================================================= */

async function handleInteractionError(
  interaction,
  error
) {
  logError(
    `INTERACTION:${interaction?.customId || interaction?.commandName || 'unknown'}`,
    error
  );

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
        flags:
          MessageFlags.Ephemeral
      });

      return;
    }

    await interaction.reply({
      content,
      flags:
        MessageFlags.Ephemeral
    });

    scheduleOriginalReplyDelete(
      interaction
    );
  } catch (_) {}
}


/* =========================================================
   P7.2 — COMMAND REGISTRATION
   ========================================================= */

async function registerGuildCommands(
  guild
) {
  if (
    !guild ||
    !client.application
  ) {
    return;
  }

  const commands = [
    setupCommand.toJSON(),
    claimCommand.toJSON(),
    panelCommand.toJSON()
  ];

  try {
    await guild.commands.set(
      commands
    );
  } catch (error) {
    logError(
      `REGISTER_COMMANDS:${guild.id}`,
      error
    );
  }
}


/* =========================================================
   P7.2 — RECONCILE GENERATOR
   ========================================================= */

async function reconcileTrackedGenerator(
  guild,
  generator
) {
  if (
    !generator?.create_voice_id
  ) {
    return;
  }

  const channel =
    await fetchChannelSafe(
      guild,
      generator.create_voice_id
    );

  /*
   * Generator bị mất trong lúc bot offline:
   * KHÔNG tự tạo lại.
   * Chỉ clear ID tracking.
   */
  if (
    !channel ||
    !isVoiceChannel(
      channel
    )
  ) {
    try {
      await pool.query(
        `
          UPDATE generators
          SET
            create_voice_id = NULL,
            updated_at = NOW()
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
        `RECONCILE_GENERATOR:${guild.id}`,
        error
      );
    }

    return;
  }

  /*
   * Nếu category bị thay đổi thủ công,
   * không adopt/move lại.
   */
  if (
    generator.button_category_id &&
    String(
      channel.parentId
    ) ===
      String(
        generator.button_category_id
      )
  ) {
    await ensureGeneratorPosition(
      guild,
      generator
    );
  }
}


/* =========================================================
   P7.2 — RECONCILE LOG CHANNELS
   ========================================================= */

async function reconcileTrackedLogChannels(
  guild,
  generator
) {
  if (!generator) {
    return;
  }

  let clearChat =
    false;

  let clearAction =
    false;

  if (
    generator.chat_log_channel_id
  ) {
    const chat =
      await fetchChannelSafe(
        guild,
        generator.chat_log_channel_id
      );

    if (
      !chat ||
      !isTextChannel(
        chat
      )
    ) {
      clearChat =
        true;
    }
  }

  if (
    generator.action_log_channel_id
  ) {
    const action =
      await fetchChannelSafe(
        guild,
        generator.action_log_channel_id
      );

    if (
      !action ||
      !isTextChannel(
        action
      )
    ) {
      clearAction =
        true;
    }
  }

  if (
    !clearChat &&
    !clearAction
  ) {
    return;
  }

  try {
    if (
      clearChat &&
      clearAction
    ) {
      await pool.query(
        `
          UPDATE generators
          SET
            chat_log_channel_id = NULL,
            action_log_channel_id = NULL,
            updated_at = NOW()
          WHERE guild_id = $1
        `,
        [
          String(
            guild.id
          )
        ]
      );
    } else if (
      clearChat
    ) {
      await pool.query(
        `
          UPDATE generators
          SET
            chat_log_channel_id = NULL,
            updated_at = NOW()
          WHERE guild_id = $1
        `,
        [
          String(
            guild.id
          )
        ]
      );
    } else {
      await pool.query(
        `
          UPDATE generators
          SET
            action_log_channel_id = NULL,
            updated_at = NOW()
          WHERE guild_id = $1
        `,
        [
          String(
            guild.id
          )
        ]
      );
    }
  } catch (error) {
    logError(
      `RECONCILE_LOG_CHANNELS:${guild.id}`,
      error
    );
  }
}


/* =========================================================
   P7.2 — RECONCILE ROOM RECORDS
   ========================================================= */

async function reconcileGuildRoomRecords(
  guild
) {
  const rooms =
    await getGuildRooms(
      guild.id
    );

  for (
    const room
    of rooms
  ) {
    const channel =
      await fetchChannelSafe(
        guild,
        room.channel_id
      );

    if (
      !channel ||
      !isVoiceChannel(
        channel
      )
    ) {
      await deleteRoomRecord(
        room.channel_id
      ).catch(
        error => {
          logError(
            `RECONCILE_STALE_ROOM:${room.channel_id}`,
            error
          );
        }
      );

      clearRoomRuntimeState(
        room.channel_id
      );

      continue;
    }

    /*
     * Nếu owner rời server hoàn toàn,
     * lifecycle absence vẫn có thể chuyển
     * cho người đang ở phòng.
     */
    await ensureOwnerDirectPermissions(
      channel,
      room.owner_id
    ).catch(
      () => {}
    );
  }
}


/* =========================================================
   P7.2 — FULL GUILD RECONCILE
   ========================================================= */

async function reconcileGuildVoiceHDK(
  guild
) {
  if (!guild) {
    return;
  }

  const generator =
    await getGenerator(
      guild.id
    ).catch(
      error => {
        logError(
          `RECONCILE_GET_GENERATOR:${guild.id}`,
          error
        );

        return null;
      }
    );

  /*
   * Server chưa setup.
   */
  if (!generator) {
    return;
  }

  await reconcileTrackedGenerator(
    guild,
    generator
  );

  await reconcileTrackedLogChannels(
    guild,
    generator
  );

  await reconcileGuildRoomRecords(
    guild
  );

  await recoverGuildRoomRuntime(
    guild
  );
}


/* =========================================================
   P7.2 — EVENT REGISTRATION
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
      await handleVoiceStateLifecycle(
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
      await handleManagedChannelDelete(
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
        `GUILD_CREATE:${guild.id}`,
        error
      );
    }
  }
);


/* =========================================================
   P7.2 — READY
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
      `[${BOT_NAME}] Servers: ${readyClient.guilds.cache.size}`
    );

    try {
      /*
       * Guild commands xuất hiện nhanh.
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
          try {
            await reconcileGuildVoiceHDK(
              guild
            );
          } catch (error) {
            logError(
              `STARTUP_RECONCILE:${guild.id}`,
              error
            );
          }
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
   P7.2 — HEALTH SERVER
   Không khai báo lại healthServer nếu P1 đã có:
       let healthServer = null;
   ========================================================= */

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

  healthServer.on(
    'error',
    error => {
      logError(
        'HEALTH_SERVER',
        error
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
}


/* =========================================================
   P7.2 — GRACEFUL SHUTDOWN
   ========================================================= */

async function shutdownVoiceHDK(
  signal
) {
  if (shuttingDown) {
    return;
  }

  shuttingDown =
    true;

  console.log(
    `[${BOT_NAME}] Đang tắt (${signal})...`
  );

  /*
   * Dừng runtime timers.
   */
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
            () => resolve()
          );
        }
      );
    } catch (_) {}

    healthServer =
      null;
  }

  try {
    await pool.end();
  } catch (_) {}

  process.exit(0);
}

process.once(
  'SIGTERM',
  () => {
    shutdownVoiceHDK(
      'SIGTERM'
    ).catch(
      error => {
        logError(
          'SHUTDOWN_SIGTERM',
          error
        );

        process.exit(1);
      }
    );
  }
);

process.once(
  'SIGINT',
  () => {
    shutdownVoiceHDK(
      'SIGINT'
    ).catch(
      error => {
        logError(
          'SHUTDOWN_SIGINT',
          error
        );

        process.exit(1);
      }
    );
  }
);


/* =========================================================
   P7.2 — PROCESS SAFETY
   ========================================================= */

process.on(
  'unhandledRejection',
  reason => {
    logError(
      'UNHANDLED_REJECTION',
      reason
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
  }
);


/* =========================================================
   P7.2 — BOOT
   ========================================================= */

async function bootVoiceHDK() {
  if (!TOKEN) {
    throw new Error(
      'Thiếu DISCORD_TOKEN.'
    );
  }

  if (!DATABASE_URL) {
    throw new Error(
      'Thiếu DATABASE_URL.'
    );
  }

  /*
   * PostgreSQL phải OK trước.
   */
  await verifyDatabaseConnection();

  console.log(
    `[${BOT_NAME}] PostgreSQL OK.`
  );

  /*
   * P1 initDatabase có migration cho DB cũ,
   * bao gồm created_at / updated_at.
   */
  await initDatabase();

  console.log(
    `[${BOT_NAME}] Database schema OK.`
  );

  /*
   * Health server chỉ khởi động sau khi DB
   * đã kiểm tra và migration thành công.
   */
  startHealthServer();

  /*
   * Cuối cùng mới login Discord.
   */
  await client.login(
    TOKEN
  );
}

bootVoiceHDK()
  .catch(
    async error => {
      logError(
        'BOOT',
        error
      );

      try {
        if (healthServer) {
          healthServer.close();
          healthServer =
            null;
        }
      } catch (_) {}

      try {
        await pool.end();
      } catch (_) {}

      process.exit(1);
    }
  );
