'use strict';

require('dotenv').config();

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

const BOT_NAME = 'Voice HDK';
const TOKEN =
  process.env.DISCORD_TOKEN ||
  process.env.TOKEN;

const DATABASE_URL =
  process.env.DATABASE_URL;

const PORT =
  Number(process.env.PORT || 3000);

const TIME_ZONE =
  'Asia/Ho_Chi_Minh';

const CREATE_VOICE_NAME =
  '➕ Tạo phòng';

const ROOM_PREFIX =
  '🔊・';

const CHAT_LOG_CHANNEL_NAME =
  '💬・nhật-ký-chat';

const ACTION_LOG_CHANNEL_NAME =
  '⚙️・nhật-ký-chức-năng';

const SUCCESS_DELETE_MS =
  5000;

const NOTICE_DELETE_MS =
  5000;

const ERROR_DELETE_MS =
  5000;

const ACTION_COOLDOWN_MS =
  1500;

const TRANSFER_TIMEOUT_MS =
  60 * 1000;

const OWNER_ABSENCE_MS =
  10 * 60 * 1000;

const OWNER_ABSENCE_GRACE_MS =
  OWNER_ABSENCE_MS;

const AUTO_TRANSFER_RETRY_MS =
  60 * 1000;

const SETUP_TIMEOUT_MS =
  10 * 60 * 1000;

const SELECTED_MEMBER_TIMEOUT_MS =
  10 * 60 * 1000;

const EMPTY_ROOM_DELETE_DELAY_MS =
  2500;

const REGION_CACHE_MS =
  30 * 60 * 1000;

if (!TOKEN) {
  throw new Error(
    'Thiếu DISCORD_TOKEN hoặc TOKEN trong biến môi trường.'
  );
}

if (!DATABASE_URL) {
  throw new Error(
    'Thiếu DATABASE_URL trong biến môi trường.'
  );
}

if (
  !Number.isInteger(PORT) ||
  PORT <= 0 ||
  PORT > 65535
) {
  throw new Error(
    'PORT không hợp lệ.'
  );
}

const client =
  new Client({
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

const pool =
  new Pool({
    connectionString:
      DATABASE_URL
  });

const panelLocks =
  new Map();

const createLocks =
  new Map();

const cooldowns =
  new Map();

const selectedMembers =
  new Map();

const pendingTransfers =
  new Map();

const setupSessions =
  new Map();

const emptyRoomTimers =
  new Map();

const ownerAbsenceRuntimeTimers =
  new Map();

// Alias dùng chung cho lớp owner-absence mới và phần runtime cũ.
// Cùng một Map để tránh hai timer chạy song song cho một phòng.
const ownerAbsenceTimers =
  ownerAbsenceRuntimeTimers;

const roomLifecycleLocks =
  new Map();

let regionCache = {
  expiresAt: 0,
  regions: []
};

let shuttingDown =
  false;

const REQUIRED_BOT_PERMISSIONS = [
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
    'Quản lý vai trò'
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

pool.on(
  'error',
  error => {
    logError(
      'POSTGRES_POOL',
      error
    );
  }
);

client.on(
  Events.Error,
  error => {
    logError(
      'DISCORD_CLIENT',
      error
    );
  }
);

client.on(
  Events.Warn,
  warning => {
    console.warn(
      `[${BOT_NAME}] [DISCORD_WARN]`,
      warning
    );
  }
);

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

    setTimeout(
      () => {
        process.exit(1);
      },
      250
    ).unref();
  }
);

const healthServer =
  http.createServer(
    (
      req,
      res
    ) => {
      if (
        req.url !== '/' &&
        req.url !== '/health'
      ) {
        res.writeHead(
          404,
          {
            'Content-Type':
              'application/json; charset=utf-8',
            'Cache-Control':
              'no-store'
          }
        );

        res.end(
          JSON.stringify({
            ok: false,
            error: 'Not Found'
          })
        );

        return;
      }

      res.writeHead(
        200,
        {
          'Content-Type':
            'application/json; charset=utf-8',
          'Cache-Control':
            'no-store'
        }
      );

      res.end(
        JSON.stringify({
          ok: true,
          service: BOT_NAME
        })
      );
    }
  );

function isSnowflake(
  value
) {
  return (
    typeof value === 'string' &&
    /^\d{16,22}$/.test(value)
  );
}

function cleanDisplayName(
  value
) {
  return String(
    value || ''
  )
    .replace(
      /\s+/g,
      ' '
    )
    .trim()
    .slice(
      0,
      50
    );
}

function cleanRoomName(
  value
) {
  let result =
    String(
      value || ''
    )
      .replace(
        /\r?\n/g,
        ' '
      )
      .replace(
        /\s+/g,
        ' '
      )
      .trim();

  if (
    result.startsWith(
      ROOM_PREFIX
    )
  ) {
    result =
      result.slice(
        ROOM_PREFIX.length
      );
  }

  result =
    result.replace(
      /^➕\s*/,
      ''
    );

  result =
    result
      .trim()
      .slice(
        0,
        80
      );

  return (
    result ||
    'Phòng thoại'
  );
}

function safeMemberName(
  member
) {
  if (!member) {
    return 'Không xác định';
  }

  const value =
    member.displayName ||
    member.user?.globalName ||
    member.user?.username ||
    'Không xác định';

  return String(value)
    .replace(
      /\r?\n/g,
      ' '
    )
    .replace(
      /\s+/g,
      ' '
    )
    .trim()
    .slice(
      0,
      80
    );
}

function vietnamTime(
  input = new Date()
) {
  const date =
    input instanceof Date
      ? input
      : new Date(input);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return 'Không rõ thời gian';
  }

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
    ).formatToParts(
      date
    );

  const values = {};

  for (
    const part
    of parts
  ) {
    if (
      part.type !==
      'literal'
    ) {
      values[
        part.type
      ] = part.value;
    }
  }

  return (
    `${values.hour}:` +
    `${values.minute}:` +
    `${values.second} ` +
    `${values.day}/` +
    `${values.month}/` +
    `${values.year}`
  );
}

function relativeTimestamp(
  input
) {
  const date =
    input instanceof Date
      ? input
      : new Date(input);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return 'sau ít phút';
  }

  return (
    `<t:${Math.floor(
      date.getTime() /
      1000
    )}:R>`
  );
}

function sleep(
  milliseconds
) {
  return new Promise(
    resolve => {
      const timer =
        setTimeout(
          resolve,
          milliseconds
        );

      timer.unref?.();
    }
  );
}

function permissionNames(
  bitfield
) {
  if (!bitfield) {
    return [];
  }

  const permissions =
    new PermissionsBitField(
      bitfield
    );

  return REQUIRED_BOT_PERMISSIONS
    .filter(
      ([flag]) =>
        permissions.has(
          flag
        )
    )
    .map(
      ([, name]) =>
        name
    );
}

async function columnExists(
  tableName,
  columnName,
  dbClient = pool
) {
  const result =
    await dbClient.query(
      `
        SELECT 1
        FROM information_schema.columns
        WHERE
          table_schema = 'public'
          AND table_name = $1
          AND column_name = $2
        LIMIT 1
      `,
      [
        tableName,
        columnName
      ]
    );

  return (
    result.rowCount >
    0
  );
}

async function dropNotNullIfColumnExists(
  tableName,
  columnName,
  dbClient
) {
  const exists =
    await columnExists(
      tableName,
      columnName,
      dbClient
    );

  if (!exists) {
    return;
  }

  const safeTable =
    `"${String(
      tableName
    ).replace(
      /"/g,
      '""'
    )}"`;

  const safeColumn =
    `"${String(
      columnName
    ).replace(
      /"/g,
      '""'
    )}"`;

  await dbClient.query(
    `
      ALTER TABLE ${safeTable}
      ALTER COLUMN ${safeColumn}
      DROP NOT NULL
    `
  );
}

async function initDatabase() {
  const dbClient =
    await pool.connect();

  try {
    await dbClient.query(
      'BEGIN'
    );

    await dbClient.query(
      `
        CREATE TABLE IF NOT EXISTS generators (
          guild_id BIGINT PRIMARY KEY,
          display_name TEXT,
          button_category_id BIGINT,
          blog_category_id BIGINT,
          create_voice_id BIGINT,
          chat_log_channel_id BIGINT,
          action_log_channel_id BIGINT,
          tracked_text_channel_id BIGINT,
          installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `
    );

    await dbClient.query(
      `
        ALTER TABLE generators
        ADD COLUMN IF NOT EXISTS display_name TEXT
      `
    );

    await dbClient.query(
      `
        ALTER TABLE generators
        ADD COLUMN IF NOT EXISTS button_category_id BIGINT
      `
    );

    await dbClient.query(
      `
        ALTER TABLE generators
        ADD COLUMN IF NOT EXISTS blog_category_id BIGINT
      `
    );

    await dbClient.query(
      `
        ALTER TABLE generators
        ADD COLUMN IF NOT EXISTS create_voice_id BIGINT
      `
    );

    await dbClient.query(
      `
        ALTER TABLE generators
        ADD COLUMN IF NOT EXISTS chat_log_channel_id BIGINT
      `
    );

    await dbClient.query(
      `
        ALTER TABLE generators
        ADD COLUMN IF NOT EXISTS action_log_channel_id BIGINT
      `
    );

    await dbClient.query(
      `
        ALTER TABLE generators
        ADD COLUMN IF NOT EXISTS tracked_text_channel_id BIGINT
      `
    );

    await dbClient.query(
      `
        ALTER TABLE generators
        ADD COLUMN IF NOT EXISTS installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      `
    );

    await dbClient.query(
      `
        ALTER TABLE generators
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      `
    );

    await dropNotNullIfColumnExists(
      'generators',
      'display_name',
      dbClient
    );

    await dropNotNullIfColumnExists(
      'generators',
      'button_category_id',
      dbClient
    );

    await dropNotNullIfColumnExists(
      'generators',
      'blog_category_id',
      dbClient
    );

    await dropNotNullIfColumnExists(
      'generators',
      'create_voice_id',
      dbClient
    );

    await dropNotNullIfColumnExists(
      'generators',
      'chat_log_channel_id',
      dbClient
    );

    await dropNotNullIfColumnExists(
      'generators',
      'action_log_channel_id',
      dbClient
    );

    await dropNotNullIfColumnExists(
      'generators',
      'tracked_text_channel_id',
      dbClient
    );

    await dbClient.query(
      `
        CREATE TABLE IF NOT EXISTS rooms (
          channel_id BIGINT PRIMARY KEY,
          guild_id BIGINT NOT NULL,
          owner_id BIGINT NOT NULL,
          category_id BIGINT,
          control_message_id BIGINT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `
    );

    await dbClient.query(
      `
        ALTER TABLE rooms
        ADD COLUMN IF NOT EXISTS guild_id BIGINT
      `
    );

    await dbClient.query(
      `
        ALTER TABLE rooms
        ADD COLUMN IF NOT EXISTS owner_id BIGINT
      `
    );

    await dbClient.query(
      `
        ALTER TABLE rooms
        ADD COLUMN IF NOT EXISTS category_id BIGINT
      `
    );

    await dbClient.query(
      `
        ALTER TABLE rooms
        ADD COLUMN IF NOT EXISTS control_message_id BIGINT
      `
    );

    await dbClient.query(
      `
        ALTER TABLE rooms
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      `
    );

    await dbClient.query(
      `
        CREATE INDEX IF NOT EXISTS idx_rooms_guild_id
        ON rooms (guild_id)
      `
    );

    await dbClient.query(
      `
        CREATE INDEX IF NOT EXISTS idx_rooms_owner
        ON rooms (guild_id, owner_id)
      `
    );

    await dbClient.query(
      `
        CREATE TABLE IF NOT EXISTS room_member_presence (
          guild_id BIGINT NOT NULL,
          channel_id BIGINT NOT NULL,
          member_id BIGINT NOT NULL,
          joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (
            channel_id,
            member_id
          )
        )
      `
    );

    await dbClient.query(
      `
        CREATE INDEX IF NOT EXISTS idx_room_member_presence_guild
        ON room_member_presence (guild_id)
      `
    );

    await dbClient.query(
      `
        CREATE INDEX IF NOT EXISTS idx_room_member_presence_joined
        ON room_member_presence (
          channel_id,
          joined_at
        )
      `
    );

    await dbClient.query(
      `
        CREATE TABLE IF NOT EXISTS room_owner_absence (
          channel_id BIGINT PRIMARY KEY,
          guild_id BIGINT NOT NULL,
          owner_id BIGINT NOT NULL,
          owner_name TEXT,
          started_at TIMESTAMPTZ NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          notice_message_id BIGINT
        )
      `
    );

    await dbClient.query(
      `
        CREATE INDEX IF NOT EXISTS idx_room_owner_absence_guild
        ON room_owner_absence (guild_id)
      `
    );

    await dbClient.query(
      `
        CREATE INDEX IF NOT EXISTS idx_room_owner_absence_expires
        ON room_owner_absence (expires_at)
      `
    );

    await dbClient.query(
      `
        CREATE TABLE IF NOT EXISTS room_presence (
          guild_id BIGINT NOT NULL,
          channel_id BIGINT NOT NULL,
          member_id BIGINT NOT NULL,
          joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (
            channel_id,
            member_id
          )
        )
      `
    );

    await dbClient.query(
      `
        CREATE INDEX IF NOT EXISTS idx_room_presence_guild
        ON room_presence (guild_id)
      `
    );

    await dbClient.query(
      `
        CREATE INDEX IF NOT EXISTS idx_room_presence_channel_joined
        ON room_presence (
          channel_id,
          joined_at
        )
      `
    );

    await dbClient.query(
      `
        CREATE TABLE IF NOT EXISTS owner_absences (
          channel_id BIGINT PRIMARY KEY,
          guild_id BIGINT NOT NULL,
          owner_id BIGINT NOT NULL,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deadline_at TIMESTAMPTZ NOT NULL,
          notice_message_id BIGINT
        )
      `
    );

    await dbClient.query(
      `
        CREATE INDEX IF NOT EXISTS idx_owner_absences_guild
        ON owner_absences (guild_id)
      `
    );

    await dbClient.query(
      `
        CREATE INDEX IF NOT EXISTS idx_owner_absences_deadline
        ON owner_absences (deadline_at)
      `
    );

    await dbClient.query(
      'COMMIT'
    );
  } catch (error) {
    await dbClient.query(
      'ROLLBACK'
    ).catch(
      () => {}
    );

    throw error;
  } finally {
    dbClient.release();
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
        guildId
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}

async function upsertGenerator({
  guildId,
  displayName,
  buttonCategoryId,
  blogCategoryId,
  createVoiceId,
  chatLogChannelId,
  actionLogChannelId,
  trackedTextChannelId = null
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
          tracked_text_channel_id,
          installed_at,
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
          $8,
          NOW(),
          NOW()
        )
        ON CONFLICT (guild_id)
        DO UPDATE SET
          display_name = EXCLUDED.display_name,
          button_category_id = EXCLUDED.button_category_id,
          blog_category_id = EXCLUDED.blog_category_id,
          create_voice_id = EXCLUDED.create_voice_id,
          chat_log_channel_id = EXCLUDED.chat_log_channel_id,
          action_log_channel_id = EXCLUDED.action_log_channel_id,
          tracked_text_channel_id = EXCLUDED.tracked_text_channel_id,
          updated_at = NOW()
        RETURNING *
      `,
      [
        guildId,
        displayName,
        buttonCategoryId,
        blogCategoryId,
        createVoiceId,
        chatLogChannelId,
        actionLogChannelId,
        trackedTextChannelId
      ]
    );

  return result.rows[0];
}

async function deleteGenerator(
  guildId,
  dbClient = pool
) {
  await dbClient.query(
    `
      DELETE FROM generators
      WHERE guild_id = $1
    `,
    [
      guildId
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
        channelId
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
        guildId
      ]
    );

  return result.rows;
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
        ORDER BY created_at ASC
        LIMIT 1
      `,
      [
        guildId,
        ownerId
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}

async function createRoomRecord({
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
          created_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          NOW()
        )
        ON CONFLICT (channel_id)
        DO UPDATE SET
          guild_id = EXCLUDED.guild_id,
          owner_id = EXCLUDED.owner_id,
          category_id = EXCLUDED.category_id,
          control_message_id = COALESCE(
            EXCLUDED.control_message_id,
            rooms.control_message_id
          )
        RETURNING *
      `,
      [
        guildId,
        channelId,
        ownerId,
        categoryId,
        controlMessageId
      ]
    );

  return result.rows[0];
}

async function setControlMessage(
  channelId,
  messageId
) {
  await pool.query(
    `
      UPDATE rooms
      SET control_message_id = $1
      WHERE channel_id = $2
    `,
    [
      messageId,
      channelId
    ]
  );
}

async function updateRoomOwner(
  channelId,
  ownerId,
  dbClient = pool
) {
  const result =
    await dbClient.query(
      `
        UPDATE rooms
        SET owner_id = $1
        WHERE channel_id = $2
        RETURNING *
      `,
      [
        ownerId,
        channelId
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}

async function deleteRoomRecord(
  channelId,
  dbClient = pool
) {
  await dbClient.query(
    `
      DELETE FROM room_member_presence
      WHERE channel_id = $1
    `,
    [
      channelId
    ]
  );

  await dbClient.query(
    `
      DELETE FROM room_owner_absence
      WHERE channel_id = $1
    `,
    [
      channelId
    ]
  );

  await dbClient.query(
    `DELETE FROM room_presence WHERE channel_id = $1`,
    [channelId]
  );

  await dbClient.query(
    `DELETE FROM owner_absences WHERE channel_id = $1`,
    [channelId]
  );

  await dbClient.query(
    `
      DELETE FROM rooms
      WHERE channel_id = $1
    `,
    [
      channelId
    ]
  );
}

async function deleteGuildRoomRecords(
  guildId,
  dbClient = pool
) {
  await dbClient.query(
    `
      DELETE FROM room_member_presence
      WHERE guild_id = $1
    `,
    [
      guildId
    ]
  );

  await dbClient.query(
    `
      DELETE FROM room_owner_absence
      WHERE guild_id = $1
    `,
    [
      guildId
    ]
  );

  await dbClient.query(
    `DELETE FROM room_presence WHERE guild_id = $1`,
    [guildId]
  );

  await dbClient.query(
    `DELETE FROM owner_absences WHERE guild_id = $1`,
    [guildId]
  );

  await dbClient.query(
    `
      DELETE FROM rooms
      WHERE guild_id = $1
    `,
    [
      guildId
    ]
  );
}

async function recordMemberPresence(
  guildId,
  channelId,
  memberId,
  joinedAt = new Date()
) {
  const validDate =
    joinedAt instanceof Date
      ? joinedAt
      : new Date(joinedAt);

  await pool.query(
    `
      INSERT INTO room_member_presence (
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
      guildId,
      channelId,
      memberId,
      validDate
    ]
  );
}

async function removeMemberPresence(
  channelId,
  memberId
) {
  await pool.query(
    `
      DELETE FROM room_member_presence
      WHERE
        channel_id = $1
        AND member_id = $2
    `,
    [
      channelId,
      memberId
    ]
  );
}

async function clearRoomPresence(
  channelId,
  dbClient = pool
) {
  await dbClient.query(
    `
      DELETE FROM room_member_presence
      WHERE channel_id = $1
    `,
    [
      channelId
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
        FROM room_member_presence
        WHERE channel_id = $1
        ORDER BY
          joined_at ASC,
          member_id ASC
      `,
      [
        channelId
      ]
    );

  return result.rows;
}

async function getMemberJoinedAt(
  channelId,
  memberId
) {
  const result =
    await pool.query(
      `
        SELECT joined_at
        FROM room_member_presence
        WHERE
          channel_id = $1
          AND member_id = $2
        LIMIT 1
      `,
      [
        channelId,
        memberId
      ]
    );

  return (
    result.rows[0]?.joined_at ||
    null
  );
}

async function saveOwnerAbsence({
  guildId,
  channelId,
  ownerId,
  ownerName,
  startedAt,
  expiresAt,
  noticeMessageId = null
}) {
  const result =
    await pool.query(
      `
        INSERT INTO room_owner_absence (
          channel_id,
          guild_id,
          owner_id,
          owner_name,
          started_at,
          expires_at,
          notice_message_id
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7
        )
        ON CONFLICT (channel_id)
        DO UPDATE SET
          guild_id = EXCLUDED.guild_id,
          owner_id = EXCLUDED.owner_id,
          owner_name = EXCLUDED.owner_name,
          started_at = EXCLUDED.started_at,
          expires_at = EXCLUDED.expires_at,
          notice_message_id = EXCLUDED.notice_message_id
        RETURNING *
      `,
      [
        channelId,
        guildId,
        ownerId,
        ownerName,
        startedAt,
        expiresAt,
        noticeMessageId
      ]
    );

  return result.rows[0];
}

async function updateOwnerAbsenceNotice(
  channelId,
  noticeMessageId
) {
  await pool.query(
    `
      UPDATE room_owner_absence
      SET notice_message_id = $1
      WHERE channel_id = $2
    `,
    [
      noticeMessageId,
      channelId
    ]
  );
}

async function getOwnerAbsence(
  channelId
) {
  const result =
    await pool.query(
      `
        SELECT *
        FROM room_owner_absence
        WHERE channel_id = $1
        LIMIT 1
      `,
      [
        channelId
      ]
    );

  return (
    result.rows[0] ||
    null
  );
}

async function getAllOwnerAbsences() {
  const result =
    await pool.query(
      `
        SELECT *
        FROM room_owner_absence
        ORDER BY expires_at ASC
      `
    );

  return result.rows;
}

async function deleteOwnerAbsence(
  channelId,
  dbClient = pool
) {
  await dbClient.query(
    `
      DELETE FROM room_owner_absence
      WHERE channel_id = $1
    `,
    [
      channelId
    ]
  );
}

function clearRuntimeOwnerAbsenceTimer(
  channelId
) {
  const key =
    String(
      channelId
    );

  const timer =
    ownerAbsenceRuntimeTimers.get(
      key
    );

  if (timer) {
    clearTimeout(
      timer
    );

    ownerAbsenceRuntimeTimers.delete(
      key
    );
  }
}

async function withRoomLifecycleLock(
  channelId,
  task
) {
  const key =
    String(
      channelId
    );

  const previous =
    roomLifecycleLocks.get(
      key
    ) ||
    Promise.resolve();

  const current =
    previous
      .catch(
        () => {}
      )
      .then(
        task
      );

  roomLifecycleLocks.set(
    key,
    current
  );

  try {
    return await current;
  } finally {
    if (
      roomLifecycleLocks.get(
        key
      ) ===
      current
    ) {
      roomLifecycleLocks.delete(
        key
      );
    }
  }
}

function selectedMemberKey(
  guildId,
  channelId,
  ownerId
) {
  return `${guildId}:${channelId}:${ownerId}`;
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

  const old =
    selectedMembers.get(
      key
    );

  if (old?.timer) {
    clearTimeout(
      old.timer
    );
  }

  const timer =
    setTimeout(
      () => {
        const current =
          selectedMembers.get(
            key
          );

        if (
          current?.memberId ===
          memberId
        ) {
          selectedMembers.delete(
            key
          );
        }
      },
      SELECTED_MEMBER_TIMEOUT_MS
    );

  timer.unref?.();

  selectedMembers.set(
    key,
    {
      memberId,
      timer
    }
  );
}

function getSelectedMemberId(
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

  return (
    selectedMembers.get(
      key
    )?.memberId ||
    null
  );
}

function clearSelectedMember(
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

  const current =
    selectedMembers.get(
      key
    );

  if (current?.timer) {
    clearTimeout(
      current.timer
    );
  }

  selectedMembers.delete(
    key
  );
}

function clearSelectionsForChannel(
  guildId,
  channelId
) {
  const prefix =
    `${guildId}:${channelId}:`;

  for (
    const [
      key,
      value
    ]
    of selectedMembers.entries()
  ) {
    if (
      !key.startsWith(
        prefix
      )
    ) {
      continue;
    }

    if (value?.timer) {
      clearTimeout(
        value.timer
      );
    }

    selectedMembers.delete(
      key
    );
  }
}

function setupSessionKey(
  guildId,
  userId
) {
  return `${guildId}:${userId}`;
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
    Date.now() >
    session.expiresAt
  ) {
    setupSessions.delete(
      key
    );

    return null;
  }

  return session;
}

function saveSetupSession(
  guildId,
  userId,
  data
) {
  const key =
    setupSessionKey(
      guildId,
      userId
    );

  const previous =
    setupSessions.get(
      key
    );

  const session = {
    ...previous,
    ...data,
    guildId,
    userId,
    expiresAt:
      Date.now() +
      SETUP_TIMEOUT_MS
  };

  setupSessions.set(
    key,
    session
  );

  return session;
}

function deleteSetupSession(
  guildId,
  userId
) {
  setupSessions.delete(
    setupSessionKey(
      guildId,
      userId
    )
  );
}
function transferKey(
  channelId
) {
  return String(
    channelId
  );
}

function getPendingTransfer(
  channelId
) {
  return (
    pendingTransfers.get(
      transferKey(
        channelId
      )
    ) ||
    null
  );
}

function clearPendingTransfer(
  channelId
) {
  const key =
    transferKey(
      channelId
    );

  const pending =
    pendingTransfers.get(
      key
    );

  if (pending?.timer) {
    clearTimeout(
      pending.timer
    );
  }

  pendingTransfers.delete(
    key
  );

  return pending || null;
}

function cooldownKey(
  action,
  guildId,
  channelId,
  userId
) {
  return [
    action,
    guildId || '0',
    channelId || '0',
    userId || '0'
  ].join(':');
}

function useCooldown(
  action,
  interaction,
  duration =
    ACTION_COOLDOWN_MS
) {
  const key =
    cooldownKey(
      action,
      interaction.guildId,
      interaction.channelId,
      interaction.user?.id
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
    return (
      expiresAt -
      now
    );
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
      duration + 1000
    );

  timer.unref?.();

  return 0;
}

async function withLock(
  map,
  key,
  task
) {
  const lockKey =
    String(
      key
    );

  const previous =
    map.get(
      lockKey
    ) ||
    Promise.resolve();

  const current =
    previous
      .catch(
        () => {}
      )
      .then(
        task
      );

  map.set(
    lockKey,
    current
  );

  try {
    return await current;
  } finally {
    if (
      map.get(
        lockKey
      ) ===
      current
    ) {
      map.delete(
        lockKey
      );
    }
  }
}

async function withPanelLock(
  channelId,
  task
) {
  return withLock(
    panelLocks,
    channelId,
    task
  );
}

async function withCreateLock(
  guildId,
  memberId,
  task
) {
  return withLock(
    createLocks,
    `${guildId}:${memberId}`,
    task
  );
}

async function getBotMember(
  guild
) {
  if (!guild) {
    return null;
  }

  if (guild.members.me) {
    return guild.members.me;
  }

  try {
    return await guild.members.fetchMe();
  } catch {
    return null;
  }
}

async function getGuildMember(
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

  const id =
    String(
      memberId
    );

  const cached =
    guild.members.cache.get(
      id
    );

  if (cached) {
    return cached;
  }

  try {
    return await guild.members.fetch(
      id
    );
  } catch {
    return null;
  }
}

async function getGuildChannel(
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

  const id =
    String(
      channelId
    );

  const cached =
    guild.channels.cache.get(
      id
    );

  if (cached) {
    return cached;
  }

  try {
    const channel =
      await guild.channels.fetch(
        id
      );

    if (
      !channel ||
      channel.guildId !==
      guild.id
    ) {
      return null;
    }

    return channel;
  } catch {
    return null;
  }
}

async function getGuildRole(
  guild,
  roleId
) {
  if (
    !guild ||
    !isSnowflake(
      String(
        roleId || ''
      )
    )
  ) {
    return null;
  }

  const id =
    String(
      roleId
    );

  const cached =
    guild.roles.cache.get(
      id
    );

  if (cached) {
    return cached;
  }

  try {
    return await guild.roles.fetch(
      id
    );
  } catch {
    return null;
  }
}

function canManageSetup(
  interaction
) {
  return Boolean(
    interaction.memberPermissions?.has(
      PermissionsBitField.Flags.ManageGuild
    ) ||
    interaction.memberPermissions?.has(
      PermissionsBitField.Flags.Administrator
    )
  );
}

function getMissingPermissions(
  permissions,
  flags =
    REQUIRED_BOT_PERMISSIONS
) {
  if (!permissions) {
    return flags.map(
      ([, label]) =>
        label
    );
  }

  return flags
    .filter(
      ([flag]) =>
        !permissions.has(
          flag
        )
    )
    .map(
      ([, label]) =>
        label
    );
}

async function validateSetupPermissions(
  guild,
  buttonCategory = null,
  blogCategory = null
) {
  const botMember =
    await getBotMember(
      guild
    );

  if (!botMember) {
    return {
      ok: false,
      missing: [
        'Không tìm thấy Bot Member'
      ]
    };
  }

  const missing =
    new Set();

  const guildMissing =
    getMissingPermissions(
      botMember.permissions
    );

  for (
    const name
    of guildMissing
  ) {
    missing.add(
      name
    );
  }

  if (buttonCategory) {
    const permissions =
      buttonCategory.permissionsFor(
        botMember
      );

    const required = [
      [
        PermissionsBitField.Flags.ViewChannel,
        'Xem kênh'
      ],
      [
        PermissionsBitField.Flags.ManageChannels,
        'Quản lý kênh'
      ],
      [
        PermissionsBitField.Flags.ManageRoles,
        'Quản lý vai trò'
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

    for (
      const name
      of getMissingPermissions(
        permissions,
        required
      )
    ) {
      missing.add(
        name
      );
    }
  }

  if (blogCategory) {
    const permissions =
      blogCategory.permissionsFor(
        botMember
      );

    const required = [
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
      ]
    ];

    for (
      const name
      of getMissingPermissions(
        permissions,
        required
      )
    ) {
      missing.add(
        name
      );
    }
  }

  return {
    ok:
      missing.size ===
      0,
    missing:
      Array.from(
        missing
      )
  };
}

async function resolveOverwriteTarget(
  channel,
  target
) {
  if (
    !channel?.guild ||
    !target
  ) {
    return null;
  }

  if (
    typeof target ===
    'object' &&
    isSnowflake(
      String(
        target.id || ''
      )
    )
  ) {
    if (
      target.user
    ) {
      return {
        id:
          String(
            target.id
          ),
        type:
          OverwriteType.Member
      };
    }

    if (
      target.permissions !==
      undefined &&
      target.managed !==
      undefined
    ) {
      return {
        id:
          String(
            target.id
          ),
        type:
          OverwriteType.Role
      };
    }
  }

  const id =
    String(
      typeof target ===
      'string'
        ? target
        : target.id || ''
    );

  if (
    !isSnowflake(
      id
    )
  ) {
    return null;
  }

  if (
    id ===
    channel.guild.roles.everyone.id
  ) {
    return {
      id,
      type:
        OverwriteType.Role
    };
  }

  const member =
    await getGuildMember(
      channel.guild,
      id
    );

  if (member) {
    return {
      id,
      type:
        OverwriteType.Member
    };
  }

  const role =
    await getGuildRole(
      channel.guild,
      id
    );

  if (role) {
    return {
      id,
      type:
        OverwriteType.Role
    };
  }

  return null;
}

async function safeEditOverwrite(
  channel,
  target,
  permissions,
  reason
) {
  const resolved =
    await resolveOverwriteTarget(
      channel,
      target
    );

  if (!resolved) {
    throw new Error(
      'Không thể xác định Member/Role cho permission overwrite.'
    );
  }

  return channel.permissionOverwrites.edit(
    resolved.id,
    permissions,
    {
      type:
        resolved.type,
      reason
    }
  );
}

async function safeDeleteOverwrite(
  channel,
  target,
  reason
) {
  const id =
    String(
      typeof target ===
      'string'
        ? target
        : target?.id || ''
    );

  if (
    !isSnowflake(
      id
    )
  ) {
    return false;
  }

  const overwrite =
    channel.permissionOverwrites.cache.get(
      id
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
      `DELETE_OVERWRITE:${channel.id}:${id}`,
      error
    );

    return false;
  }
}

async function ensureBotRoomPermissions(
  channel
) {
  const botMember =
    await getBotMember(
      channel.guild
    );

  if (!botMember) {
    throw new Error(
      'Không tìm thấy bot trong server.'
    );
  }

  await safeEditOverwrite(
    channel,
    botMember,
    {
      ViewChannel:
        true,
      Connect:
        true,
      SendMessages:
        true,
      ReadMessageHistory:
        true,
      EmbedLinks:
        true,
      ManageChannels:
        true,
      ManageRoles:
        true,
      MoveMembers:
        true
    },
    `${BOT_NAME}: đảm bảo quyền quản lý phòng`
  );
}

async function grantOwnerPermissions(
  channel,
  owner
) {
  const member =
    typeof owner ===
    'string'
      ? await getGuildMember(
          channel.guild,
          owner
        )
      : owner;

  if (!member) {
    throw new Error(
      'Không tìm thấy chủ phòng trong server.'
    );
  }

  await safeEditOverwrite(
    channel,
    member,
    {
      ViewChannel:
        true,
      Connect:
        true
    },
    `${BOT_NAME}: cấp quyền chủ phòng`
  );
}

async function removeOwnerPermissions(
  channel,
  owner
) {
  const id =
    typeof owner ===
    'string'
      ? owner
      : owner?.id;

  if (!id) {
    return;
  }

  await safeDeleteOverwrite(
    channel,
    id,
    `${BOT_NAME}: thu hồi quyền chủ phòng`
  );
}

async function inviteMemberToRoom(
  channel,
  member,
  inviter = null
) {
  if (
    !member ||
    member.guild.id !==
    channel.guild.id
  ) {
    throw new Error(
      'Thành viên không hợp lệ.'
    );
  }

  await safeEditOverwrite(
    channel,
    member,
    {
      ViewChannel:
        true,
      Connect:
        true
    },
    `${BOT_NAME}: mời thành viên`
  );

  const inviteUrl =
    `https://discord.com/channels/${channel.guild.id}/${channel.id}`;

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setLabel('Tham gia phòng')
          .setEmoji('🔊')
          .setStyle(ButtonStyle.Link)
          .setURL(inviteUrl)
      );

  let dmSent = false;

  try {
    await member.send({
      content: [
        `✉️ **${safeMemberName(inviter)} đã mời bạn tham gia phòng thoại.**`,
        `🔊 **${channel.name}**`,
        `🏠 Server: **${channel.guild.name}**`,
        '',
        'Bạn đã được cấp quyền **xem phòng** và **kết nối**.'
      ].join('\n'),
      components: [row]
    });

    dmSent = true;
  } catch {
    dmSent = false;
  }

  return {
    dmSent,
    inviteUrl
  };
}

async function denyMemberFromRoom(
  channel,
  member
) {
  if (
    !member ||
    member.guild.id !==
    channel.guild.id
  ) {
    throw new Error(
      'Thành viên không hợp lệ.'
    );
  }

  await safeEditOverwrite(
    channel,
    member,
    {
      ViewChannel:
        false,
      Connect:
        false
    },
    `${BOT_NAME}: cấm thành viên`
  );

  if (
    member.voice?.channelId ===
    channel.id
  ) {
    try {
      await member.voice.disconnect(
        `${BOT_NAME}: thành viên bị cấm khỏi phòng`
      );
    } catch (error) {
      logError(
        `DENY_DISCONNECT:${channel.id}:${member.id}`,
        error
      );
    }
  }
}

async function kickMemberFromRoom(
  channel,
  member
) {
  if (
    !member ||
    member.guild.id !==
    channel.guild.id
  ) {
    throw new Error(
      'Thành viên không hợp lệ.'
    );
  }

  if (
    member.voice?.channelId !==
    channel.id
  ) {
    throw new Error(
      'Thành viên không ở trong phòng.'
    );
  }

  await member.voice.disconnect(
    `${BOT_NAME}: đuổi thành viên khỏi phòng`
  );
}

async function clearMemberOverwrites(
  channel,
  ownerId
) {
  const everyoneId =
    channel.guild.roles.everyone.id;

  const botMember =
    await getBotMember(
      channel.guild
    );

  const botId =
    botMember?.id ||
    client.user?.id ||
    null;

  const keep =
    new Set(
      [
        everyoneId,
        String(
          ownerId
        ),
        botId
      ].filter(
        Boolean
      )
    );

  const overwrites =
    Array.from(
      channel.permissionOverwrites.cache.values()
    );

  for (
    const overwrite
    of overwrites
  ) {
    if (
      keep.has(
        overwrite.id
      )
    ) {
      continue;
    }

    try {
      await overwrite.delete(
        `${BOT_NAME}: đặt lại phòng`
      );
    } catch (error) {
      logError(
        `RESET_OVERWRITE:${channel.id}:${overwrite.id}`,
        error
      );
    }
  }
}

async function resetRoomState(
  channel,
  owner
) {
  await clearMemberOverwrites(
    channel,
    owner.id
  );

  await safeEditOverwrite(
    channel,
    channel.guild.roles.everyone,
    {
      ViewChannel:
        true,
      Connect:
        true
    },
    `${BOT_NAME}: đặt lại quyền mặc định`
  );

  await grantOwnerPermissions(
    channel,
    owner
  );

  await ensureBotRoomPermissions(
    channel
  );

  if (
    channel.userLimit !==
    0
  ) {
    await channel.setUserLimit(
      0,
      `${BOT_NAME}: đặt lại giới hạn`
    );
  }

  if (
    channel.rtcRegion !==
    null
  ) {
    await channel.setRTCRegion(
      null,
      `${BOT_NAME}: đặt lại khu vực`
    );
  }
}

function getRoomState(
  channel
) {
  const everyone =
    channel.permissionOverwrites.cache.get(
      channel.guild.roles.everyone.id
    );

  const connect =
    everyone?.deny?.has(
      PermissionsBitField.Flags.Connect
    )
      ? false
      : true;

  const visible =
    everyone?.deny?.has(
      PermissionsBitField.Flags.ViewChannel
    )
      ? false
      : true;

  return {
    locked:
      !connect,
    hidden:
      !visible,
    limit:
      channel.userLimit ||
      0,
    region:
      channel.rtcRegion ||
      null
  };
}

async function getRoomOwnerMember(
  channel,
  room
) {
  return getGuildMember(
    channel.guild,
    String(
      room.owner_id
    )
  );
}

async function getSelectedMember(
  interaction,
  room
) {
  const memberId =
    getSelectedMemberId(
      interaction.guildId,
      interaction.channelId,
      String(
        room.owner_id
      )
    );

  if (!memberId) {
    return null;
  }

  return getGuildMember(
    interaction.guild,
    memberId
  );
}

function deleteReplyLater(
  interaction,
  delay =
    SUCCESS_DELETE_MS
) {
  const timer =
    setTimeout(
      async () => {
        try {
          await interaction.deleteReply();
        } catch {
        }
      },
      delay
    );

  timer.unref?.();
}

function deleteMessageLater(
  message,
  delay =
    SUCCESS_DELETE_MS
) {
  if (!message) {
    return;
  }

  const timer =
    setTimeout(
      async () => {
        try {
          await message.delete();
        } catch {
        }
      },
      delay
    );

  timer.unref?.();
}

async function safeDeferUpdate(
  interaction
) {
  if (
    interaction.deferred ||
    interaction.replied
  ) {
    return;
  }

  await interaction.deferUpdate();
}

async function safeDeferReply(
  interaction,
  ephemeral = true
) {
  if (
    interaction.deferred ||
    interaction.replied
  ) {
    return;
  }

  await interaction.deferReply({
    flags: ephemeral ? MessageFlags.Ephemeral : undefined
  });
}

function buildStatusEmbed(
  content,
  error = false
) {
  return new EmbedBuilder()
    .setColor(
      error
        ? 0xED4245
        : 0x57F287
    )
    .setDescription(
      String(content || '')
    );
}

async function tempReply(
  interaction,
  content,
  {
    error = false,
    duration = null
  } = {}
) {
  const delay =
    duration ??
    (
      error
        ? ERROR_DELETE_MS
        : SUCCESS_DELETE_MS
    );

  if (
    interaction.deferred
  ) {
    await interaction.editReply({
      content: '',
      embeds: [
        buildStatusEmbed(
          content,
          error
        )
      ],
      components: []
    });

    deleteReplyLater(
      interaction,
      delay
    );

    return;
  }

  if (
    interaction.replied
  ) {
    return tempFollowUp(
      interaction,
      content,
      {
        error,
        duration:
          delay
      }
    );
  }

  await interaction.reply({
    content: '',
    embeds: [
      buildStatusEmbed(
        content,
        error
      )
    ]
  });

  deleteReplyLater(
    interaction,
    delay
  );
}

async function tempFollowUp(
  interaction,
  content,
  {
    error = false,
    duration = null
  } = {}
) {
  const delay =
    duration ??
    (
      error
        ? ERROR_DELETE_MS
        : SUCCESS_DELETE_MS
    );

  const message =
    await interaction.followUp({
      content: '',
      embeds: [
        buildStatusEmbed(
          content,
          error
        )
      ],
      fetchReply: true
    });

  deleteMessageLater(
    message,
    delay
  );

  return message;
}

async function getVoiceRegions(
  force = false
) {
  const now =
    Date.now();

  if (
    !force &&
    regionCache.expiresAt >
      now &&
    regionCache.regions.length
  ) {
    return regionCache.regions;
  }

  const regions =
    await client.fetchVoiceRegions();

  const normalized =
    Array.from(
      regions.values()
    )
      .map(
        region => ({
          id:
            String(
              region.id
            ),
          name:
            String(
              region.name ||
              region.id
            ),
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
        })
      )
      .filter(
        region =>
          !region.deprecated
      )
      .sort(
        (
          a,
          b
        ) => {
          if (
            a.optimal !==
            b.optimal
          ) {
            return a.optimal
              ? -1
              : 1;
          }

          return a.name.localeCompare(
            b.name,
            'vi'
          );
        }
      );

  regionCache = {
    expiresAt:
      now +
      REGION_CACHE_MS,
    regions:
      normalized
  };

  return normalized;
}

async function validateVoiceRegion(
  regionId
) {
  if (
    regionId ===
    'automatic' ||
    regionId ===
    null
  ) {
    return {
      id: null,
      name:
        'Tự động'
    };
  }

  const regions =
    await getVoiceRegions();

  let found =
    regions.find(
      region =>
        region.id ===
        regionId
    );

  if (!found) {
    const refreshed =
      await getVoiceRegions(
        true
      );

    found =
      refreshed.find(
        region =>
          region.id ===
          regionId
      );
  }

  return found || null;
}

async function fetchMessageSafe(
  channel,
  messageId
) {
  if (
    !channel?.messages ||
    !isSnowflake(
      String(
        messageId || ''
      )
    )
  ) {
    return null;
  }

  try {
    return await channel.messages.fetch(
      String(
        messageId
      )
    );
  } catch {
    return null;
  }
}

function clearEmptyRoomTimer(
  channelId
) {
  const key =
    String(
      channelId
    );

  const timer =
    emptyRoomTimers.get(
      key
    );

  if (timer) {
    clearTimeout(
      timer
    );

    emptyRoomTimers.delete(
      key
    );
  }
}

async function sendTemporaryChannelNotice(
  channel,
  content,
  duration =
    NOTICE_DELETE_MS
) {
  if (
    !channel?.send
  ) {
    return null;
  }

  try {
    const message =
      await channel.send({
        content,
        allowedMentions: {
          parse: []
        }
      });

    deleteMessageLater(
      message,
      duration
    );

    return message;
  } catch (error) {
    logError(
      `TEMP_NOTICE:${channel?.id || 'UNKNOWN'}`,
      error
    );

    return null;
  }
}

function buildSetupPanel(
  session
) {
  const displayName =
    cleanDisplayName(
      session.displayName
    ) ||
    'Chưa nhập';

  const buttonCategory =
    session.buttonCategoryId
      ? `<#${session.buttonCategoryId}>`
      : 'Chưa chọn';

  const blogCategory =
    session.blogCategoryId
      ? `<#${session.blogCategoryId}>`
      : 'Chưa chọn';

  const embed =
    new EmbedBuilder()
      .setTitle(
        '⚙️ Thiết lập Voice HDK'
      )
      .setDescription(
        [
          '**🏷️ Tên Server**',
          displayName,
          '',
          '**📁 Danh mục đặt nút**',
          buttonCategory,
          '',
          '**📁 Danh mục đặt Blog**',
          blogCategory
        ].join('\n')
      )
      .setFooter({
        text:
          `✦ ${BOT_NAME} • ${displayName}`
      });

  const nameRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'setup_name'
          )
          .setLabel(
            'Nhập / đổi tên Server'
          )
          .setEmoji(
            '🏷️'
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  const buttonCategoryRow =
    new ActionRowBuilder()
      .addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(
            'setup_button_category'
          )
          .setPlaceholder(
            '📁 Chọn danh mục đặt nút'
          )
          .setChannelTypes(
            ChannelType.GuildCategory
          )
          .setMinValues(
            1
          )
          .setMaxValues(
            1
          )
      );

  const blogCategoryRow =
    new ActionRowBuilder()
      .addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(
            'setup_blog_category'
          )
          .setPlaceholder(
            '📁 Chọn danh mục đặt Blog'
          )
          .setChannelTypes(
            ChannelType.GuildCategory
          )
          .setMinValues(
            1
          )
          .setMaxValues(
            1
          )
      );

  const installRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'setup_install'
          )
          .setLabel(
            'Cài đặt'
          )
          .setEmoji(
            '✅'
          )
          .setStyle(
            ButtonStyle.Success
          )
      );

  return {
    embeds: [
      embed
    ],
    components: [
      nameRow,
      buttonCategoryRow,
      blogCategoryRow,
      installRow
    ]
  };
}

function buildReinstallPanel() {
  const embed =
    new EmbedBuilder()
      .setTitle(
        '⚠️ CÀI ĐẶT LẠI VOICE HDK'
      )
      .setDescription(
        [
          'Server này đã được cài đặt Voice HDK.',
          '',
          'Tiếp tục sẽ xóa hệ thống Voice HDK cũ',
          'và cho phép bạn thiết lập lại từ đầu.'
        ].join('\n')
      );

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'setup_reinstall_confirm'
          )
          .setLabel(
            'Cài đặt lại'
          )
          .setEmoji(
            '♻️'
          )
          .setStyle(
            ButtonStyle.Danger
          ),
        new ButtonBuilder()
          .setCustomId(
            'setup_uninstall'
          )
          .setLabel(
            'Gỡ cài đặt'
          )
          .setEmoji(
            '🗑️'
          )
          .setStyle(
            ButtonStyle.Danger
          ),
        new ButtonBuilder()
          .setCustomId(
            'setup_reinstall_cancel'
          )
          .setLabel(
            'Hủy'
          )
          .setEmoji(
            '✖️'
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  return {
    embeds: [
      embed
    ],
    components: [
      row
    ]
  };
}

function buildSetupSuccessPanel(
  displayName,
  buttonCategoryId,
  blogCategoryId
) {
  const embed =
    new EmbedBuilder()
      .setTitle(
        '🎉 CÀI ĐẶT VOICE HDK THÀNH CÔNG!'
      )
      .setDescription(
        [
          'Chúc mừng! Voice HDK đã được cài đặt thành công',
          'và hiện đã sẵn sàng để sử dụng.',
          '',
          `🏷️ **Tên Server:** ${displayName}`,
          `📁 **Danh mục đặt nút:** <#${buttonCategoryId}>`,
          `📁 **Danh mục Blog:** <#${blogCategoryId}>`,
          '',
          'Nếu có bất kỳ thắc mắc hoặc cần hỗ trợ:',
          '👤 Huỳnh Duy Khánh',
          '☎️ 0988850044',
          '',
          'Cảm ơn bạn đã sử dụng Voice HDK ❤️'
        ].join('\n')
      )
      .setFooter({
        text:
          `✦ ${BOT_NAME} • ${displayName}`
      });

  return {
    embeds: [
      embed
    ],
    components: []
  };
}
async function handleSetupCommand(
  interaction
) {
  await safeDeferReply(
    interaction,
    true
  );

  if (!interaction.guild) {
    await tempReply(
      interaction,
      '❌ Lệnh này chỉ sử dụng trong server.',
      {
        error: true
      }
    );

    return;
  }

  if (
    !canManageSetup(
      interaction
    )
  ) {
    await tempReply(
      interaction,
      '❌ Bạn cần quyền Quản lý Server để cài đặt Voice HDK.',
      {
        error: true
      }
    );

    return;
  }

  try {
    const existing =
      await getGenerator(
        interaction.guild.id
      );

    if (existing) {
      saveSetupSession(
        interaction.guild.id,
        interaction.user.id,
        {
          mode:
            'reinstall-confirm'
        }
      );

      await interaction.editReply(
        buildReinstallPanel()
      );

      return;
    }

    const session =
      saveSetupSession(
        interaction.guild.id,
        interaction.user.id,
        {
          mode:
            'setup',
          displayName:
            '',
          buttonCategoryId:
            null,
          blogCategoryId:
            null
        }
      );

    await interaction.editReply(
      buildSetupPanel(
        session
      )
    );
  } catch (error) {
    logError(
      'SETUP_COMMAND',
      error
    );

    await tempReply(
      interaction,
      '❌ Không thể mở trình cài đặt Voice HDK.',
      {
        error: true
      }
    );
  }
}

async function handleSetupNameButton(
  interaction
) {
  if (
    !interaction.guild ||
    !canManageSetup(
      interaction
    )
  ) {
    await tempReply(
      interaction,
      '❌ Bạn không có quyền thực hiện thao tác này.',
      {
        error: true
      }
    );

    return;
  }

  const session =
    getSetupSession(
      interaction.guild.id,
      interaction.user.id
    );

  if (
    !session ||
    session.mode !==
      'setup'
  ) {
    await tempReply(
      interaction,
      '⚠️ Phiên thiết lập đã hết hạn. Hãy dùng `/setup` lại.',
      {
        error: true
      }
    );

    return;
  }

  const modal =
    new ModalBuilder()
      .setCustomId(
        'setup_name_modal'
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
        'Tên Server'
      )
      .setPlaceholder(
        'Ví dụ: ABCD'
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
        50
      );

  if (
    session.displayName
  ) {
    input.setValue(
      cleanDisplayName(
        session.displayName
      )
    );
  }

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

async function handleSetupNameModal(
  interaction
) {
  await safeDeferReply(
    interaction,
    true
  );

  if (
    !interaction.guild ||
    !canManageSetup(
      interaction
    )
  ) {
    await tempReply(
      interaction,
      '❌ Bạn không có quyền thực hiện thao tác này.',
      {
        error: true
      }
    );

    return;
  }

  const session =
    getSetupSession(
      interaction.guild.id,
      interaction.user.id
    );

  if (
    !session ||
    session.mode !==
      'setup'
  ) {
    await tempReply(
      interaction,
      '⚠️ Phiên thiết lập đã hết hạn. Hãy dùng `/setup` lại.',
      {
        error: true
      }
    );

    return;
  }

  const displayName =
    cleanDisplayName(
      interaction.fields.getTextInputValue(
        'setup_display_name'
      )
    );

  if (!displayName) {
    await tempReply(
      interaction,
      '❌ Tên Server không hợp lệ.',
      {
        error: true
      }
    );

    return;
  }

  saveSetupSession(
    interaction.guild.id,
    interaction.user.id,
    {
      displayName
    }
  );

  await tempReply(
    interaction,
    `✅ Đã lưu tên Server: ${displayName}`
  );

  try {
    const originalMessageId =
      session.panelMessageId;

    if (
      originalMessageId &&
      session.panelChannelId
    ) {
      const panelChannel =
        await getGuildChannel(
          interaction.guild,
          session.panelChannelId
        );

      const panelMessage =
        await fetchMessageSafe(
          panelChannel,
          originalMessageId
        );

      if (panelMessage) {
        const updated =
          getSetupSession(
            interaction.guild.id,
            interaction.user.id
          );

        await panelMessage.edit(
          buildSetupPanel(
            updated
          )
        );
      }
    }
  } catch (error) {
    logError(
      'SETUP_NAME_PANEL_REFRESH',
      error
    );
  }
}

async function handleSetupCategorySelect(
  interaction,
  type
) {
  await safeDeferUpdate(
    interaction
  );

  if (
    !interaction.guild ||
    !canManageSetup(
      interaction
    )
  ) {
    await tempFollowUp(
      interaction,
      '❌ Bạn không có quyền thực hiện thao tác này.',
      {
        error: true
      }
    );

    return;
  }

  const session =
    getSetupSession(
      interaction.guild.id,
      interaction.user.id
    );

  if (
    !session ||
    session.mode !==
      'setup'
  ) {
    await tempFollowUp(
      interaction,
      '⚠️ Phiên thiết lập đã hết hạn. Hãy dùng `/setup` lại.',
      {
        error: true
      }
    );

    return;
  }

  const channelId =
    interaction.values?.[0];

  const category =
    await getGuildChannel(
      interaction.guild,
      channelId
    );

  if (
    !category ||
    category.type !==
      ChannelType.GuildCategory
  ) {
    await tempFollowUp(
      interaction,
      '❌ Danh mục không hợp lệ.',
      {
        error: true
      }
    );

    return;
  }

  if (
    type ===
    'button'
  ) {
    saveSetupSession(
      interaction.guild.id,
      interaction.user.id,
      {
        buttonCategoryId:
          category.id
      }
    );
  } else {
    saveSetupSession(
      interaction.guild.id,
      interaction.user.id,
      {
        blogCategoryId:
          category.id
      }
    );
  }

  const updated =
    getSetupSession(
      interaction.guild.id,
      interaction.user.id
    );

  await interaction.editReply(
    buildSetupPanel(
      updated
    )
  );
}

async function safeDeleteManagedChannel(
  guild,
  channelId,
  reason
) {
  const channel =
    await getGuildChannel(
      guild,
      String(
        channelId || ''
      )
    );

  if (!channel) {
    return true;
  }

  try {
    await channel.delete(
      reason
    );
    return true;
  } catch (error) {
    logError(
      `DELETE_MANAGED_CHANNEL:${channel.id}`,
      error
    );
    return false;
  }
}

async function cleanupGuildInstallation(
  guild
) {
  const generator =
    await getGenerator(
      guild.id
    );

  const rooms =
    await getGuildRooms(
      guild.id
    );

  const failedDeletes = [];

  for (
    const room
    of rooms
  ) {
    clearEmptyRoomTimer(
      room.channel_id
    );

    clearRuntimeOwnerAbsenceTimer(
      room.channel_id
    );

    clearPendingTransfer(
      room.channel_id
    );

    clearSelectionsForChannel(
      guild.id,
      room.channel_id
    );

    if (!(await safeDeleteManagedChannel(
      guild,
      room.channel_id,
      `${BOT_NAME}: cài đặt lại hệ thống`
    ))) {
      failedDeletes.push(String(room.channel_id));
    }
  }

  if (generator) {
    if (!(await safeDeleteManagedChannel(
      guild,
      generator.create_voice_id,
      `${BOT_NAME}: cài đặt lại hệ thống`
    ))) {
      failedDeletes.push(String(generator.create_voice_id));
    }

    if (!(await safeDeleteManagedChannel(
      guild,
      generator.chat_log_channel_id,
      `${BOT_NAME}: cài đặt lại hệ thống`
    ))) {
      failedDeletes.push(String(generator.chat_log_channel_id));
    }

    if (!(await safeDeleteManagedChannel(
      guild,
      generator.action_log_channel_id,
      `${BOT_NAME}: cài đặt lại hệ thống`
    ))) {
      failedDeletes.push(String(generator.action_log_channel_id));
    }
  }

  if (failedDeletes.length > 0) {
    const error = new Error('CLEANUP_CHANNEL_DELETE_FAILED');
    error.channelIds = failedDeletes;
    throw error;
  }

  const dbClient =
    await pool.connect();

  try {
    await dbClient.query(
      'BEGIN'
    );

    await deleteGuildRoomRecords(
      guild.id,
      dbClient
    );

    await dbClient.query(
      `DELETE FROM room_presence WHERE guild_id = $1`,
      [guild.id]
    );

    await dbClient.query(
      `DELETE FROM owner_absences WHERE guild_id = $1`,
      [guild.id]
    );

    await deleteGenerator(
      guild.id,
      dbClient
    );

    await dbClient.query(
      'COMMIT'
    );
  } catch (error) {
    await dbClient.query(
      'ROLLBACK'
    ).catch(
      () => {}
    );

    throw error;
  } finally {
    dbClient.release();
  }
}

async function handleReinstallConfirm(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  if (
    !interaction.guild ||
    !canManageSetup(
      interaction
    )
  ) {
    await tempFollowUp(
      interaction,
      '❌ Bạn không có quyền cài đặt lại Voice HDK.',
      {
        error: true
      }
    );

    return;
  }

  const session =
    getSetupSession(
      interaction.guild.id,
      interaction.user.id
    );

  if (
    !session ||
    session.mode !==
      'reinstall-confirm'
  ) {
    await tempFollowUp(
      interaction,
      '⚠️ Phiên xác nhận đã hết hạn. Hãy dùng `/setup` lại.',
      {
        error: true
      }
    );

    return;
  }

  try {
    await cleanupGuildInstallation(
      interaction.guild
    );

    const fresh =
      saveSetupSession(
        interaction.guild.id,
        interaction.user.id,
        {
          mode:
            'setup',
          displayName:
            '',
          buttonCategoryId:
            null,
          blogCategoryId:
            null
        }
      );

    await interaction.editReply(
      buildSetupPanel(
        fresh
      )
    );
  } catch (error) {
    logError(
      'REINSTALL_CONFIRM',
      error
    );

    await tempFollowUp(
      interaction,
      '❌ Không thể dọn hệ thống cũ. Không tiếp tục cài đặt để tránh trạng thái dang dở.',
      {
        error: true
      }
    );
  }
}

async function handleSetupUninstall(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  if (
    !interaction.guild ||
    !canManageSetup(interaction)
  ) {
    await tempFollowUp(
      interaction,
      '❌ Bạn không có quyền gỡ cài đặt Voice HDK.',
      { error: true }
    );
    return;
  }

  try {
    await cleanupGuildInstallation(
      interaction.guild
    );

    for (const [key, value] of setupSessions.entries()) {
      if (key.startsWith(`${interaction.guild.id}:`)) {
        if (value?.timer) clearTimeout(value.timer);
        setupSessions.delete(key);
      }
    }

    for (const [key, value] of selectedMembers.entries()) {
      if (key.startsWith(`${interaction.guild.id}:`)) {
        if (value?.timer) clearTimeout(value.timer);
        selectedMembers.delete(key);
      }
    }

    await interaction.editReply({
      content: '✅ Đã gỡ cài đặt Voice HDK khỏi server này và xóa dữ liệu Voice HDK của server khỏi Neon.',
      embeds: [],
      components: []
    });

    deleteReplyLater(
      interaction,
      SUCCESS_DELETE_MS
    );
  } catch (error) {
    logError('SETUP_UNINSTALL', error);
    await tempFollowUp(
      interaction,
      '❌ Gỡ cài đặt chưa hoàn tất. Bot giữ lại dữ liệu theo dõi nếu có kênh quản lý không xóa được để tránh dữ liệu mồ côi.',
      { error: true }
    );
  }
}

async function handleReinstallCancel(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  if (
    interaction.guild
  ) {
    deleteSetupSession(
      interaction.guild.id,
      interaction.user.id
    );
  }

  await interaction.editReply({
    content:
      '✖️ Đã hủy cài đặt lại Voice HDK.',
    embeds: [],
    components: []
  });

  deleteReplyLater(
    interaction,
    SUCCESS_DELETE_MS
  );
}

async function createGeneratorVoiceChannel(
  guild,
  category
) {
  return guild.channels.create({
    name:
      CREATE_VOICE_NAME,
    type:
      ChannelType.GuildVoice,
    parent:
      category.id,
    reason:
      `${BOT_NAME}: tạo kênh tạo phòng`
  });
}

async function createManagedLogChannel(
  guild,
  category,
  name
) {
  return guild.channels.create({
    name,
    type:
      ChannelType.GuildText,
    parent:
      category.id,
    reason:
      `${BOT_NAME}: tạo kênh nhật ký`
  });
}

async function rollbackSetupChannels(
  channels
) {
  for (
    const channel
    of channels.reverse()
  ) {
    if (!channel) {
      continue;
    }

    try {
      await channel.delete(
        `${BOT_NAME}: hoàn tác cài đặt lỗi`
      );
    } catch {
    }
  }
}

async function installGuildSystem(
  guild,
  session
) {
  const displayName =
    cleanDisplayName(
      session.displayName
    );

  if (!displayName) {
    throw new Error(
      'SETUP_NAME_REQUIRED'
    );
  }

  const buttonCategory =
    await getGuildChannel(
      guild,
      session.buttonCategoryId
    );

  const blogCategory =
    await getGuildChannel(
      guild,
      session.blogCategoryId
    );

  if (
    !buttonCategory ||
    buttonCategory.type !==
      ChannelType.GuildCategory
  ) {
    throw new Error(
      'SETUP_BUTTON_CATEGORY_INVALID'
    );
  }

  if (
    !blogCategory ||
    blogCategory.type !==
      ChannelType.GuildCategory
  ) {
    throw new Error(
      'SETUP_BLOG_CATEGORY_INVALID'
    );
  }

  const permissionCheck =
    await validateSetupPermissions(
      guild,
      buttonCategory,
      blogCategory
    );

  if (
    !permissionCheck.ok
  ) {
    const error =
      new Error(
        'SETUP_MISSING_PERMISSIONS'
      );

    error.missing =
      permissionCheck.missing;

    throw error;
  }

  const existing =
    await getGenerator(
      guild.id
    );

  if (existing) {
    throw new Error(
      'SETUP_ALREADY_EXISTS'
    );
  }

  const created = [];

  try {
    const createVoice =
      await createGeneratorVoiceChannel(
        guild,
        buttonCategory
      );

    created.push(
      createVoice
    );

    const chatLog =
      await createManagedLogChannel(
        guild,
        blogCategory,
        CHAT_LOG_CHANNEL_NAME
      );

    created.push(
      chatLog
    );

    const actionLog =
      await createManagedLogChannel(
        guild,
        blogCategory,
        ACTION_LOG_CHANNEL_NAME
      );

    created.push(
      actionLog
    );

    const generator =
      await saveGenerator({
        guildId:
          guild.id,
        displayName,
        buttonCategoryId:
          buttonCategory.id,
        blogCategoryId:
          blogCategory.id,
        createVoiceId:
          createVoice.id,
        chatLogChannelId:
          chatLog.id,
        actionLogChannelId:
          actionLog.id
      });

    return {
      generator,
      createVoice,
      chatLog,
      actionLog,
      buttonCategory,
      blogCategory
    };
  } catch (error) {
    await rollbackSetupChannels(
      created
    );

    throw error;
  }
}

async function handleSetupInstall(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  if (
    !interaction.guild ||
    !canManageSetup(
      interaction
    )
  ) {
    await tempFollowUp(
      interaction,
      '❌ Bạn không có quyền cài đặt Voice HDK.',
      {
        error: true
      }
    );

    return;
  }

  const session =
    getSetupSession(
      interaction.guild.id,
      interaction.user.id
    );

  if (
    !session ||
    session.mode !==
      'setup'
  ) {
    await tempFollowUp(
      interaction,
      '⚠️ Phiên thiết lập đã hết hạn. Hãy dùng `/setup` lại.',
      {
        error: true
      }
    );

    return;
  }

  if (
    !cleanDisplayName(
      session.displayName
    )
  ) {
    await tempFollowUp(
      interaction,
      '⚠️ Hãy nhập Tên Server trước.',
      {
        error: true
      }
    );

    return;
  }

  if (
    !session.buttonCategoryId
  ) {
    await tempFollowUp(
      interaction,
      '⚠️ Hãy chọn Danh mục đặt nút.',
      {
        error: true
      }
    );

    return;
  }

  if (
    !session.blogCategoryId
  ) {
    await tempFollowUp(
      interaction,
      '⚠️ Hãy chọn Danh mục đặt Blog.',
      {
        error: true
      }
    );

    return;
  }

  try {
    const result =
      await installGuildSystem(
        interaction.guild,
        session
      );

    deleteSetupSession(
      interaction.guild.id,
      interaction.user.id
    );

    await interaction.editReply(
      buildSetupSuccessPanel(
        result.generator.display_name,
        result.buttonCategory.id,
        result.blogCategory.id
      )
    );
  } catch (error) {
    logError(
      'SETUP_INSTALL',
      error
    );

    if (
      error.message ===
      'SETUP_MISSING_PERMISSIONS'
    ) {
      await tempFollowUp(
        interaction,
        [
          '❌ Bot chưa đủ quyền để cài đặt.',
          '',
          `Thiếu: ${(
            error.missing ||
            []
          ).join(', ')}`
        ].join('\n'),
        {
          error: true
        }
      );

      return;
    }

    if (
      error.message ===
      'SETUP_ALREADY_EXISTS'
    ) {
      await tempFollowUp(
        interaction,
        '⚠️ Server đã có hệ thống Voice HDK. Hãy chạy `/setup` lại để cài đặt lại.',
        {
          error: true
        }
      );

      return;
    }

    await tempFollowUp(
      interaction,
      '❌ Cài đặt thất bại. Các kênh vừa tạo đã được hoàn tác để tránh hệ thống dang dở.',
      {
        error: true
      }
    );
  }
}
function humanMembers(
  channel
) {
  if (
    !channel?.members
  ) {
    return [];
  }

  return Array.from(
    channel.members.values()
  ).filter(
    member =>
      !member.user?.bot
  );
}

function buildRoomDashboard(
  channel,
  owner,
  generator
) {
  const state =
    getRoomState(
      channel
    );

  const humans =
    humanMembers(
      channel
    );

  const ownerName =
    owner
      ? safeMemberName(
          owner
        )
      : 'Không xác định';

  const displayName =
    cleanDisplayName(
      generator?.display_name
    ) ||
    'Voice HDK';

  const limit =
    channel.userLimit > 0
      ? channel.userLimit
      : '∞';

  const region =
    channel.rtcRegion
      ? channel.rtcRegion
      : 'Tự động';

  const body = [
    `🔊  PHÒNG CỦA ${ownerName.toUpperCase()}`,
    '────────────────────────────',
    `👑 Chủ phòng    @${ownerName}`,
    `👥 Thành viên   ${humans.length} / ${limit}`,
    `🔓 Phòng        ${
      state.locked
        ? 'Đang khóa'
        : 'Đang mở'
    }`,
    `👁 Hiển thị     ${
      state.hidden
        ? 'Đang ẩn'
        : 'Công khai'
    }`,
    `🌐 Khu vực      ${region}`,
    '────────────────────────────',
    `✦ ${BOT_NAME} • ${displayName}`
  ];

  const embed =
    new EmbedBuilder()
      .setColor(0x8899E8)
      .setDescription(
        `\`\`\`\n${body.join('\n')}\n\`\`\``
      );

  return {
    content: '',
    embeds: [embed],
    allowedMentions: {
      parse: []
    }
  };
}

function buildRoomButtons(
  channel
) {
  const state =
    getRoomState(
      channel
    );

  const row1 =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'room_lock'
          )
          .setLabel(
            state.locked
              ? 'Mở'
              : 'Khóa'
          )
          .setEmoji(
            state.locked
              ? '🔓'
              : '🔒'
          )
          .setStyle(
            state.locked
              ? ButtonStyle.Success
              : ButtonStyle.Secondary
          ),

        new ButtonBuilder()
          .setCustomId(
            'room_hide'
          )
          .setLabel(
            state.hidden
              ? 'Hiện'
              : 'Ẩn'
          )
          .setEmoji(
            state.hidden
              ? '👁️'
              : '🙈'
          )
          .setStyle(
            state.hidden
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

  const row2 =
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
            ButtonStyle.Secondary
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
            '✉️'
          )
          .setStyle(
            ButtonStyle.Success
          )
      );

  const row3 =
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

  return [
    row1,
    row2,
    row3
  ];
}

function buildMemberSelectRow() {
  return new ActionRowBuilder()
    .addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(
          `room_member:${Date.now().toString(36)}`
        )
        .setPlaceholder(
          '👤 Chọn thành viên'
        )
        .setMinValues(
          1
        )
        .setMaxValues(
          1
        )
    );
}

function regionLabel(
  region
) {
  if (!region) {
    return 'Tự động';
  }

  return (
    region.name ||
    region.id ||
    'Không xác định'
  );
}

async function buildRegionSelectRow(
  channel
) {
  let regions = [];

  try {
    regions =
      await getVoiceRegions();
  } catch (error) {
    logError(
      `BUILD_REGION_SELECT:${channel.id}`,
      error
    );
  }

  const current =
    channel.rtcRegion ||
    null;

  const menu =
    new StringSelectMenuBuilder()
      .setCustomId(
        'room_region'
      )
      .setPlaceholder(
        '🌐 Chọn vùng — Tự động'
      )
      .setMinValues(
        1
      )
      .setMaxValues(
        1
      );

  const options = [
    {
      label:
        'Tự động',
      value:
        'automatic',
      description:
        'Discord tự chọn khu vực phù hợp',
      emoji:
        '🌐',
      default:
        current ===
        null
    }
  ];

  for (
    const region
    of regions
  ) {
    if (
      options.length >=
      25
    ) {
      break;
    }

    options.push({
      label:
        regionLabel(
          region
        ).slice(
          0,
          100
        ),
      value:
        region.id,
      description:
        (
          region.optimal
            ? 'Khu vực được Discord đề xuất'
            : `Voice Region: ${region.id}`
        ).slice(
          0,
          100
        ),
      default:
        current ===
        region.id
    });
  }

  menu.addOptions(
    options
  );

  return new ActionRowBuilder()
    .addComponents(
      menu
    );
}

async function buildRoomPanelPayload(
  channel,
  room
) {
  const owner =
    await getRoomOwnerMember(
      channel,
      room
    );

  const generator =
    await getGenerator(
      channel.guild.id
    );

  const dashboard =
    buildRoomDashboard(
      channel,
      owner,
      generator
    );

  const buttonRows =
    buildRoomButtons(
      channel
    );

  const memberRow =
    buildMemberSelectRow();

  const regionRow =
    await buildRegionSelectRow(
      channel
    );

  return {
    ...dashboard,
    components: [
      ...buttonRows,
      memberRow,
      regionRow
    ]
  };
}

function isRoomPanelMessage(
  message
) {
  if (
    !message ||
    message.author?.id !==
      client.user?.id
  ) {
    return false;
  }

  if (
    !Array.isArray(
      message.components
    ) ||
    message.components.length ===
      0
  ) {
    return false;
  }

  const customIds = [];

  for (
    const row
    of message.components
  ) {
    for (
      const component
      of row.components ||
      []
    ) {
      if (
        component.customId
      ) {
        customIds.push(
          component.customId
        );
      }
    }
  }

  return (
    customIds.includes(
      'room_lock'
    ) &&
    customIds.some(
      customId =>
        customId === 'room_member' ||
        customId.startsWith(
          'room_member:'
        )
    ) &&
    customIds.includes(
      'room_region'
    )
  );
}

async function findRoomPanelMessages(
  channel
) {
  if (
    !channel?.messages
  ) {
    return [];
  }

  try {
    const messages =
      await channel.messages.fetch({
        limit: 50
      });

    return Array.from(
      messages.values()
    )
      .filter(
        isRoomPanelMessage
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
      `FIND_PANEL:${channel.id}`,
      error
    );

    return [];
  }
}

async function deleteDuplicatePanels(
  messages,
  keepMessageId
) {
  for (
    const message
    of messages
  ) {
    if (
      message.id ===
      keepMessageId
    ) {
      continue;
    }

    try {
      await message.delete();
    } catch {
    }
  }
}

async function refreshRoomPanelSafe(
  channelId,
  {
    forceRebuild = false
  } = {}
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
        await getGuildChannel(
          guild,
          String(
            room.channel_id
          )
        );

      if (
        !channel ||
        channel.type !==
          ChannelType.GuildVoice
      ) {
        return null;
      }

      const payload =
        await buildRoomPanelPayload(
          channel,
          room
        );

      let panelMessage =
        null;

      if (
        !forceRebuild &&
        room.control_message_id
      ) {
        panelMessage =
          await fetchMessageSafe(
            channel,
            String(
              room.control_message_id
            )
          );

        if (
          panelMessage &&
          !isRoomPanelMessage(
            panelMessage
          )
        ) {
          panelMessage =
            null;
        }
      }

      const discovered =
        await findRoomPanelMessages(
          channel
        );

      if (
        !panelMessage &&
        discovered.length >
        0
      ) {
        panelMessage =
          discovered[0];
      }

      if (
        forceRebuild &&
        panelMessage
      ) {
        try {
          await panelMessage.delete();
        } catch {
        }

        panelMessage =
          null;
      }

      if (!panelMessage) {
        panelMessage =
          await channel.send(
            payload
          );
      } else {
        await panelMessage.edit(
          payload
        );
      }

      await setControlMessage(
        channel.id,
        panelMessage.id
      );

      const allPanels =
        await findRoomPanelMessages(
          channel
        );

      await deleteDuplicatePanels(
        allPanels,
        panelMessage.id
      );

      return panelMessage;
    }
  );
}

async function moveMemberSafe(
  member,
  channel
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
      `${BOT_NAME}: chuyển vào phòng cá nhân`
    );

    return true;
  } catch (error) {
    logError(
      `MOVE_MEMBER:${member.id}:${channel.id}`,
      error
    );

    return false;
  }
}

async function getExistingOwnedChannel(
  guild,
  memberId
) {
  const room =
    await getOwnedRoom(
      guild.id,
      memberId
    );

  if (!room) {
    return null;
  }

  const channel =
    await getGuildChannel(
      guild,
      String(
        room.channel_id
      )
    );

  if (
    !channel ||
    channel.type !==
      ChannelType.GuildVoice
  ) {
    clearEmptyRoomTimer(
      room.channel_id
    );

    clearRuntimeOwnerAbsenceTimer(
      room.channel_id
    );

    clearPendingTransfer(
      room.channel_id
    );

    clearSelectionsForChannel(
      guild.id,
      room.channel_id
    );

    await deleteRoomRecord(
      room.channel_id
    );

    return null;
  }

  return {
    room,
    channel
  };
}

async function createPersonalVoiceRoom(
  member,
  generator
) {
  const guild =
    member.guild;

  const category =
    await getGuildChannel(
      guild,
      String(
        generator.button_category_id
      )
    );

  if (
    !category ||
    category.type !==
      ChannelType.GuildCategory
  ) {
    throw new Error(
      'GENERATOR_CATEGORY_MISSING'
    );
  }

  const roomName =
    `${ROOM_PREFIX}Phòng của ${cleanRoomName(
      safeMemberName(
        member
      )
    )}`;

  const botMember =
    await getBotMember(
      guild
    );

  if (!botMember) {
    throw new Error(
      'BOT_MEMBER_MISSING'
    );
  }

  const channel =
    await guild.channels.create({
      name:
        roomName,
      type:
        ChannelType.GuildVoice,
      parent:
        category.id,
      permissionOverwrites: [
        {
          id:
            guild.roles.everyone.id,
          type:
            OverwriteType.Role,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.Connect
          ]
        },
        {
          id:
            member.id,
          type:
            OverwriteType.Member,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.Connect
          ]
        },
        {
          id:
            botMember.id,
          type:
            OverwriteType.Member,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.EmbedLinks,
            PermissionsBitField.Flags.ManageChannels,
            PermissionsBitField.Flags.ManageRoles,
            PermissionsBitField.Flags.MoveMembers
          ]
        }
      ],
      reason:
        `${BOT_NAME}: tạo phòng tạm cho ${safeMemberName(
          member
        )}`
    });

  try {
    await createRoomRecord({
      guildId:
        guild.id,
      channelId:
        channel.id,
      ownerId:
        member.id,
      categoryId:
        category.id
    });

    await recordMemberPresence(
      guild.id,
      channel.id,
      member.id,
      new Date()
    );

    await refreshRoomPanelSafe(
      channel.id
    );

    return channel;
  } catch (error) {
    try {
      await channel.delete(
        `${BOT_NAME}: hoàn tác tạo phòng lỗi`
      );
    } catch {
    }

    await deleteRoomRecord(
      channel.id
    ).catch(
      () => {}
    );

    throw error;
  }
}

async function syncCurrentRoomPresence(
  channel
) {
  const room =
    await getRoom(
      channel.id
    );

  if (!room) {
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
          member.id
      )
    );

  const rows =
    await getRoomPresence(
      channel.id
    );

  for (
    const row
    of rows
  ) {
    const memberId =
      String(
        row.member_id
      );

    if (
      !currentIds.has(
        memberId
      )
    ) {
      await removeMemberPresence(
        channel.id,
        memberId
      );
    }
  }

  const knownIds =
    new Set(
      rows.map(
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
      knownIds.has(
        member.id
      )
    ) {
      continue;
    }

    await recordMemberPresence(
      channel.guild.id,
      channel.id,
      member.id,
      new Date()
    );
  }
}

async function recordVoiceJoinIfManaged(
  channelId,
  member
) {
  if (
    !channelId ||
    !member ||
    member.user?.bot
  ) {
    return;
  }

  const room =
    await getRoom(
      channelId
    );

  if (!room) {
    return;
  }

  await recordMemberPresence(
    member.guild.id,
    channelId,
    member.id,
    new Date()
  );
}

async function recordVoiceLeaveIfManaged(
  channelId,
  memberId
) {
  if (
    !channelId ||
    !memberId
  ) {
    return;
  }

  const room =
    await getRoom(
      channelId
    );

  if (!room) {
    return;
  }

  await removeMemberPresence(
    channelId,
    memberId
  );
}

async function handleJoinCreateVoice(
  voiceState
) {
  const member =
    voiceState.member;

  if (
    !member ||
    member.user?.bot ||
    !voiceState.channelId
  ) {
    return;
  }

  const generator =
    await getGenerator(
      voiceState.guild.id
    );

  if (
    !generator ||
    String(
      generator.create_voice_id ||
      ''
    ) !==
    voiceState.channelId
  ) {
    return;
  }

  await withCreateLock(
    voiceState.guild.id,
    member.id,
    async () => {
      if (
        member.voice?.channelId !==
        String(
          generator.create_voice_id
        )
      ) {
        return;
      }

      const existing =
        await getExistingOwnedChannel(
          voiceState.guild,
          member.id
        );

      if (existing) {
        clearEmptyRoomTimer(
          existing.channel.id
        );

        const moved =
          await moveMemberSafe(
            member,
            existing.channel
          );

        if (moved) {
          await recordMemberPresence(
            voiceState.guild.id,
            existing.channel.id,
            member.id,
            new Date()
          );

          await refreshRoomPanelSafe(
            existing.channel.id
          );

          await sendActionLog(
            voiceState.guild,
            '🔊',
            safeMemberName(
              member
            ),
            `Quay lại phòng ${existing.channel.name}`
          );
        }

        return;
      }

      let channel =
        null;

      try {
        channel =
          await createPersonalVoiceRoom(
            member,
            generator
          );

        if (
          member.voice?.channelId !==
          String(
            generator.create_voice_id
          )
        ) {
          if (
            humanMembers(
              channel
            ).length ===
            0
          ) {
            scheduleEmptyRoomCheck(
              channel.id,
              0
            );
          }

          return;
        }

        const moved =
          await moveMemberSafe(
            member,
            channel
          );

        if (!moved) {
          scheduleEmptyRoomCheck(
            channel.id,
            0
          );

          return;
        }

        await recordMemberPresence(
          voiceState.guild.id,
          channel.id,
          member.id,
          new Date()
        );

        await refreshRoomPanelSafe(
          channel.id
        );

        await sendActionLog(
          voiceState.guild,
          '➕',
          safeMemberName(
            member
          ),
          `Tạo phòng ${channel.name}`
        );
      } catch (error) {
        logError(
          `CREATE_TEMP_ROOM:${voiceState.guild.id}:${member.id}`,
          error
        );

        if (channel) {
          scheduleEmptyRoomCheck(
            channel.id,
            0
          );
        }
      }
    }
  );
}

async function deleteEmptyRoom(
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
        clearEmptyRoomTimer(
          channelId
        );

        clearRuntimeOwnerAbsenceTimer(
          channelId
        );

        clearPendingTransfer(
          channelId
        );

        return false;
      }

      const guild =
        client.guilds.cache.get(
          String(
            room.guild_id
          )
        );

      if (!guild) {
        return false;
      }

      const channel =
        await getGuildChannel(
          guild,
          String(
            room.channel_id
          )
        );

      if (
        !channel ||
        channel.type !==
          ChannelType.GuildVoice
      ) {
        clearRuntimeOwnerAbsenceTimer(
          channelId
        );

        clearPendingTransfer(
          channelId
        );

        clearSelectionsForChannel(
          guild.id,
          channelId
        );

        await deleteRoomRecord(
          channelId
        );

        return true;
      }

      const humans =
        humanMembers(
          channel
        );

      if (
        humans.length >
        0
      ) {
        return false;
      }

      const channelName =
        channel.name;

      clearRuntimeOwnerAbsenceTimer(
        channel.id
      );

      clearPendingTransfer(
        channel.id
      );

      clearSelectionsForChannel(
        guild.id,
        channel.id
      );

      const absence =
        await getOwnerAbsence(
          channel.id
        ).catch(
          () => null
        );

      if (
        absence?.notice_message_id
      ) {
        const notice =
          await fetchMessageSafe(
            channel,
            String(
              absence.notice_message_id
            )
          );

        if (notice) {
          try {
            await notice.delete();
          } catch {
          }
        }
      }

      try {
        await channel.delete(
          `${BOT_NAME}: tự xóa phòng rỗng`
        );
      } catch (error) {
        logError(
          `DELETE_EMPTY_CHANNEL:${channel.id}`,
          error
        );

        return false;
      }

      await deleteRoomRecord(
        channel.id
      );

      if (
        typeof sendActionLog ===
        'function'
      ) {
        await sendActionLog(
          guild,
          '🗑️',
          BOT_NAME,
          `Xóa phòng ${channelName}`
        ).catch(
          () => {}
        );
      }

      return true;
    }
  );
}

function scheduleEmptyRoomCheck(
  channelId,
  delay =
    EMPTY_ROOM_DELETE_DELAY_MS
) {
  clearEmptyRoomTimer(
    channelId
  );

  const timer =
    setTimeout(
      () => {
        emptyRoomTimers.delete(
          String(
            channelId
          )
        );

        deleteEmptyRoom(
          String(
            channelId
          )
        ).catch(
          error => {
            logError(
              `EMPTY_ROOM_CHECK:${channelId}`,
              error
            );
          }
        );
      },
      delay
    );

  timer.unref?.();

  emptyRoomTimers.set(
    String(
      channelId
    ),
    timer
  );
}

async function refreshRoomAfterVoiceChange(
  channelId
) {
  if (!channelId) {
    return;
  }

  const room =
    await getRoom(
      channelId
    );

  if (!room) {
    return;
  }

  const guild =
    client.guilds.cache.get(
      String(
        room.guild_id
      )
    );

  if (!guild) {
    return;
  }

  const channel =
    await getGuildChannel(
      guild,
      String(
        room.channel_id
      )
    );

  if (
    !channel ||
    channel.type !==
      ChannelType.GuildVoice
  ) {
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
    scheduleEmptyRoomCheck(
      channel.id
    );

    return;
  }

  clearEmptyRoomTimer(
    channel.id
  );

  await syncCurrentRoomPresence(
    channel
  );

  await refreshRoomPanelSafe(
    channel.id
  );
}

async function getOwnerRoomContext(
  interaction
) {
  if (
    !interaction.guild ||
    !interaction.channel ||
    interaction.channel.type !==
      ChannelType.GuildVoice
  ) {
    return {
      ok: false,
      message:
        '❌ Bảng điều khiển này không còn nằm trong phòng thoại hợp lệ.'
    };
  }

  const room =
    await getRoom(
      interaction.channel.id
    );

  if (!room) {
    return {
      ok: false,
      message:
        '❌ Phòng này không còn được Voice HDK quản lý.'
    };
  }

  if (
    String(
      room.owner_id
    ) !==
    interaction.user.id
  ) {
    return {
      ok: false,
      message:
        '❌ Chỉ chủ phòng mới có thể sử dụng chức năng này.'
    };
  }

  const owner =
    await getGuildMember(
      interaction.guild,
      interaction.user.id
    );

  if (
    !owner ||
    owner.voice?.channelId !==
      interaction.channel.id
  ) {
    return {
      ok: false,
      message:
        '❌ Chủ phòng phải đang ở trong phòng để sử dụng chức năng này.'
    };
  }

  return {
    ok: true,
    room,
    channel:
      interaction.channel,
    owner
  };
}

async function getRequiredSelectedMember(
  interaction,
  context
) {
  const selectedId =
    getSelectedMemberId(
      interaction.guild.id,
      context.channel.id,
      context.owner.id
    );

  if (!selectedId) {
    return {
      ok: false,
      message:
        '⚠️ Hãy chọn một thành viên ở danh sách bên dưới trước.'
    };
  }

  if (
    selectedId ===
    context.owner.id
  ) {
    return {
      ok: false,
      message:
        '⚠️ Bạn không thể chọn chính mình cho thao tác này.'
    };
  }

  let member = null;

  try {
    member =
      await interaction.guild.members.fetch(
        selectedId
      );
  } catch {
    member =
      await getGuildMember(
        interaction.guild,
        selectedId
      );
  }

  if (!member) {
    clearSelectedMember(
      interaction.guild.id,
      context.channel.id,
      context.owner.id
    );

    await refreshRoomPanelSafe(
      context.channel.id
    ).catch(() => {});

    return {
      ok: false,
      message:
        '❌ Thành viên đã chọn không còn trong server.'
    };
  }

  if (
    member.user.bot
  ) {
    return {
      ok: false,
      message:
        '❌ Không thể áp dụng thao tác này cho bot.'
    };
  }

  return {
    ok: true,
    member
  };
}

async function handleRoomMemberSelect(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempFollowUp(
      interaction,
      context.message,
      {
        error: true
      }
    );

    return;
  }

  const memberId =
    interaction.values?.[0];

  if (
    !isSnowflake(
      String(
        memberId || ''
      )
    )
  ) {
    await tempFollowUp(
      interaction,
      '❌ Thành viên được chọn không hợp lệ.',
      {
        error: true
      }
    );

    return;
  }

  if (
    memberId ===
    context.owner.id
  ) {
    clearSelectedMember(
      interaction.guild.id,
      context.channel.id,
      context.owner.id
    );

    await refreshRoomPanelSafe(
      context.channel.id
    ).catch(() => {});

    await tempFollowUp(
      interaction,
      '⚠️ Bạn không cần chọn chính mình.',
      {
        error: true
      }
    );

    return;
  }

  const member =
    await getGuildMember(
      interaction.guild,
      memberId
    );

  if (
    !member ||
    member.user.bot
  ) {
    clearSelectedMember(
      interaction.guild.id,
      context.channel.id,
      context.owner.id
    );

    await refreshRoomPanelSafe(
      context.channel.id
    ).catch(() => {});

    await tempFollowUp(
      interaction,
      '❌ Thành viên được chọn không hợp lệ.',
      {
        error: true
      }
    );

    return;
  }

  setSelectedMember(
    interaction.guild.id,
    context.channel.id,
    context.owner.id,
    member.id
  );
}

async function handleRoomLock(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const remaining =
    useCooldown(
      'room_lock',
      interaction
    );

  if (remaining > 0) {
    await tempFollowUp(
      interaction,
      '⏳ Thao tác quá nhanh. Hãy thử lại sau một chút.',
      {
        error: true
      }
    );

    return;
  }

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempFollowUp(
      interaction,
      context.message,
      {
        error: true
      }
    );

    return;
  }

  try {
    const state =
      getRoomState(
        context.channel
      );

    const newLocked =
      !state.locked;

    await setRoomLocked(
      context.channel,
      newLocked
    );

    await ensureBotRoomPermissions(
      context.channel
    );

    await grantOwnerPermissions(
      context.channel,
      context.owner
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    await sendActionLog(
      interaction.guild,
      newLocked
        ? '🔒'
        : '🔓',
      safeMemberName(
        context.owner
      ),
      `${
        newLocked
          ? 'Khóa'
          : 'Mở'
      } phòng ${context.channel.name}`
    );

    await tempFollowUp(
      interaction,
      newLocked
        ? '🔒 Đã khóa phòng.'
        : '🔓 Đã mở phòng.'
    );
  } catch (error) {
    logError(
      'ROOM_LOCK',
      error
    );

    await tempFollowUp(
      interaction,
      '❌ Không thể thay đổi trạng thái khóa phòng.',
      {
        error: true
      }
    );
  }
}

async function handleRoomHide(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const remaining =
    useCooldown(
      'room_hide',
      interaction
    );

  if (remaining > 0) {
    await tempFollowUp(
      interaction,
      '⏳ Thao tác quá nhanh. Hãy thử lại sau một chút.',
      {
        error: true
      }
    );

    return;
  }

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempFollowUp(
      interaction,
      context.message,
      {
        error: true
      }
    );

    return;
  }

  try {
    const state =
      getRoomState(
        context.channel
      );

    const newHidden =
      !state.hidden;

    await setRoomHidden(
      context.channel,
      newHidden
    );

    await ensureBotRoomPermissions(
      context.channel
    );

    await grantOwnerPermissions(
      context.channel,
      context.owner
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    await sendActionLog(
      interaction.guild,
      newHidden
        ? '🙈'
        : '👁️',
      safeMemberName(
        context.owner
      ),
      `${
        newHidden
          ? 'Ẩn'
          : 'Hiện'
      } phòng ${context.channel.name}`
    );

    await tempFollowUp(
      interaction,
      newHidden
        ? '🙈 Đã ẩn phòng.'
        : '👁️ Đã hiện phòng.'
    );
  } catch (error) {
    logError(
      'ROOM_HIDE',
      error
    );

    await tempFollowUp(
      interaction,
      '❌ Không thể thay đổi trạng thái hiển thị.',
      {
        error: true
      }
    );
  }
}
async function handleRoomRenameButton(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempReply(
      interaction,
      context.message,
      {
        error: true
      }
    );

    return;
  }

  const remaining =
    useCooldown(
      'room_rename_open',
      interaction
    );

  if (remaining > 0) {
    await tempReply(
      interaction,
      '⏳ Hãy chờ một chút trước khi mở lại biểu mẫu.',
      {
        error: true
      }
    );

    return;
  }

  const modal =
    new ModalBuilder()
      .setCustomId(
        'room_rename_modal'
      )
      .setTitle(
        'Đổi tên phòng'
      );

  const currentName =
    cleanRoomName(
      context.channel.name
    );

  const input =
    new TextInputBuilder()
      .setCustomId(
        'room_new_name'
      )
      .setLabel(
        'Tên phòng mới'
      )
      .setPlaceholder(
        'Ví dụ: Gaming'
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
      )
      .setValue(
        currentName.slice(
          0,
          80
        )
      );

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

async function handleRoomRenameModal(
  interaction
) {
  await safeDeferReply(
    interaction,
    false
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempReply(
      interaction,
      context.message,
      {
        error: true
      }
    );

    return;
  }

  const remaining =
    useCooldown(
      'room_rename_submit',
      interaction,
      3000
    );

  if (remaining > 0) {
    await tempReply(
      interaction,
      '⏳ Bạn vừa đổi tên phòng. Hãy chờ một chút.',
      {
        error: true
      }
    );

    return;
  }

  const requested =
    cleanRoomName(
      interaction.fields.getTextInputValue(
        'room_new_name'
      )
    );

  if (!requested) {
    await tempReply(
      interaction,
      '❌ Tên phòng không hợp lệ.',
      {
        error: true
      }
    );

    return;
  }

  const newName =
    `${ROOM_PREFIX}${requested}`;

  try {
    if (
      context.channel.name !==
      newName
    ) {
      await context.channel.setName(
        newName,
        `${BOT_NAME}: chủ phòng đổi tên`
      );
    }

    await refreshRoomPanelSafe(
      context.channel.id
    );

    await sendActionLog(
      interaction.guild,
      '✏️',
      safeMemberName(
        context.owner
      ),
      `Đổi tên phòng thành ${newName}`
    );

    await tempReply(
      interaction,
      `✅ Đã đổi tên phòng thành ${newName}`
    );
  } catch (error) {
    logError(
      'ROOM_RENAME',
      error
    );

    await tempReply(
      interaction,
      '❌ Không thể đổi tên phòng.',
      {
        error: true
      }
    );
  }
}

async function handleRoomLimitButton(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempReply(
      interaction,
      context.message,
      {
        error: true
      }
    );

    return;
  }

  const modal =
    new ModalBuilder()
      .setCustomId(
        'room_limit_modal'
      )
      .setTitle(
        'Giới hạn phòng'
      );

  const input =
    new TextInputBuilder()
      .setCustomId(
        'room_user_limit'
      )
      .setLabel(
        'Số người tối đa (0 = không giới hạn)'
      )
      .setPlaceholder(
        'Ví dụ: 5'
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
          context.channel.userLimit ||
          0
        )
      );

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

async function handleRoomLimitModal(
  interaction
) {
  await safeDeferReply(
    interaction,
    false
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempReply(
      interaction,
      context.message,
      {
        error: true
      }
    );

    return;
  }

  const remaining =
    useCooldown(
      'room_limit_submit',
      interaction
    );

  if (remaining > 0) {
    await tempReply(
      interaction,
      '⏳ Thao tác quá nhanh. Hãy thử lại sau một chút.',
      {
        error: true
      }
    );

    return;
  }

  const raw =
    interaction.fields
      .getTextInputValue(
        'room_user_limit'
      )
      .trim();

  if (
    !/^\d{1,2}$/.test(
      raw
    )
  ) {
    await tempReply(
      interaction,
      '❌ Giới hạn phải là số từ 0 đến 99.',
      {
        error: true
      }
    );

    return;
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
    await tempReply(
      interaction,
      '❌ Giới hạn phải nằm trong khoảng 0 đến 99.',
      {
        error: true
      }
    );

    return;
  }

  try {
    await context.channel.setUserLimit(
      limit,
      `${BOT_NAME}: thay đổi giới hạn phòng`
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    await sendActionLog(
      interaction.guild,
      '👥',
      safeMemberName(
        context.owner
      ),
      limit === 0
        ? 'Bỏ giới hạn phòng'
        : `Giới hạn phòng: ${limit} người`
    );

    await tempReply(
      interaction,
      limit === 0
        ? '👥 Đã bỏ giới hạn số người.'
        : `👥 Đã giới hạn phòng ở ${limit} người.`
    );
  } catch (error) {
    logError(
      'ROOM_LIMIT',
      error
    );

    await tempReply(
      interaction,
      '❌ Không thể thay đổi giới hạn phòng.',
      {
        error: true
      }
    );
  }
}

async function handleRoomInvite(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempFollowUp(
      interaction,
      context.message,
      {
        error: true
      }
    );

    return;
  }

  const selected =
    await getRequiredSelectedMember(
      interaction,
      context
    );

  if (!selected.ok) {
    await tempFollowUp(
      interaction,
      selected.message,
      {
        error: true
      }
    );

    return;
  }

  const member =
    selected.member;

  try {
    const inviteResult =
      await inviteMemberToRoom(
        context.channel,
        member,
        context.owner
      );

    clearSelectedMember(
      interaction.guild.id,
      context.channel.id,
      context.owner.id
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    await sendActionLog(
      interaction.guild,
      '✉️',
      safeMemberName(
        context.owner
      ),
      `Mời ${safeMemberName(
        member
      )} vào phòng`
    );

    await tempFollowUp(
      interaction,
      inviteResult.dmSent
        ? `✉️ <@${context.owner.id}> đã mời <@${member.id}> vào **${context.channel.name}**. Lời mời đã được gửi qua DM và quyền xem/kết nối đã được cấp.`
        : `✉️ <@${context.owner.id}> đã mời <@${member.id}> vào **${context.channel.name}** và đã cấp quyền xem/kết nối, nhưng không thể gửi DM cho thành viên này.`
    );
  } catch (error) {
    logError(
      'ROOM_INVITE',
      error
    );

    await tempFollowUp(
      interaction,
      '❌ Không thể mời thành viên vào phòng.',
      {
        error: true
      }
    );
  }
}

async function handleRoomDeny(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempFollowUp(
      interaction,
      context.message,
      {
        error: true
      }
    );

    return;
  }

  const selected =
    await getRequiredSelectedMember(
      interaction,
      context
    );

  if (!selected.ok) {
    await tempFollowUp(
      interaction,
      selected.message,
      {
        error: true
      }
    );

    return;
  }

  const member =
    selected.member;

  if (
    member.voice?.channelId !==
    context.channel.id
  ) {
    clearSelectedMember(
      interaction.guild.id,
      context.channel.id,
      context.owner.id
    );

    await refreshRoomPanelSafe(
      context.channel.id
    ).catch(() => {});

    await tempFollowUp(
      interaction,
      `⚠️ ${safeMemberName(member)} không có mặt trong phòng này.`,
      { error: true }
    );

    return;
  }

  try {
    await denyMemberFromRoom(
      context.channel,
      member
    );

    clearSelectedMember(
      interaction.guild.id,
      context.channel.id,
      context.owner.id
    );

    await removeMemberPresence(
      context.channel.id,
      member.id
    ).catch(
      () => {}
    );

    await refreshRoomAfterVoiceChange(
      context.channel.id
    );

    await sendActionLog(
      interaction.guild,
      '⛔',
      safeMemberName(
        context.owner
      ),
      `Cấm ${safeMemberName(
        member
      )} khỏi phòng`
    );

    await tempFollowUp(
      interaction,
      `⛔ Đã cấm ${safeMemberName(
        member
      )} khỏi phòng.`
    );
  } catch (error) {
    logError(
      'ROOM_DENY',
      error
    );

    await tempFollowUp(
      interaction,
      '❌ Không thể cấm thành viên.',
      {
        error: true
      }
    );
  }
}

async function handleRoomKick(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempFollowUp(
      interaction,
      context.message,
      {
        error: true
      }
    );

    return;
  }

  const selected =
    await getRequiredSelectedMember(
      interaction,
      context
    );

  if (!selected.ok) {
    await tempFollowUp(
      interaction,
      selected.message,
      {
        error: true
      }
    );

    return;
  }

  const member =
    selected.member;

  if (
    member.voice?.channelId !==
    context.channel.id
  ) {
    clearSelectedMember(
      interaction.guild.id,
      context.channel.id,
      context.owner.id
    );

    await refreshRoomPanelSafe(
      context.channel.id
    ).catch(() => {});

    await tempFollowUp(
      interaction,
      `⚠️ ${safeMemberName(member)} không có mặt trong phòng này.`,
      {
        error: true
      }
    );

    return;
  }

  try {
    await kickMemberFromRoom(
      context.channel,
      member
    );

    clearSelectedMember(
      interaction.guild.id,
      context.channel.id,
      context.owner.id
    );

    await removeMemberPresence(
      context.channel.id,
      member.id
    ).catch(
      () => {}
    );

    await refreshRoomAfterVoiceChange(
      context.channel.id
    );

    await sendActionLog(
      interaction.guild,
      '👢',
      safeMemberName(
        context.owner
      ),
      `Đuổi ${safeMemberName(
        member
      )} khỏi phòng`
    );

    await tempFollowUp(
      interaction,
      `👢 Đã đuổi ${safeMemberName(
        member
      )} khỏi phòng.`
    );
  } catch (error) {
    logError(
      'ROOM_KICK',
      error
    );

    await tempFollowUp(
      interaction,
      '❌ Không thể đuổi thành viên.',
      {
        error: true
      }
    );
  }
}

function buildResetConfirmation() {
  const embed =
    new EmbedBuilder()
      .setTitle(
        '♻️ ĐẶT LẠI PHÒNG'
      )
      .setDescription(
        [
          'Phòng sẽ được đưa về trạng thái mặc định:',
          '',
          '🔓 Mở phòng',
          '👁️ Công khai',
          '👥 Không giới hạn',
          '🌐 Khu vực tự động',
          '🧹 Xóa quyền Mời / Cấm riêng của thành viên',
          '',
          '**Phòng và quyền chủ sẽ không bị xóa.**'
        ].join('\n')
      );

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'room_reset_confirm'
          )
          .setLabel(
            'Xác nhận'
          )
          .setEmoji(
            '♻️'
          )
          .setStyle(
            ButtonStyle.Danger
          ),

        new ButtonBuilder()
          .setCustomId(
            'room_reset_cancel'
          )
          .setLabel(
            'Hủy'
          )
          .setEmoji(
            '✖️'
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  return {
    embeds: [
      embed
    ],
    components: [
      row
    ]
  };
}

async function handleRoomResetButton(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempReply(
      interaction,
      context.message,
      {
        error: true
      }
    );

    return;
  }

  await interaction.reply({
    ...buildResetConfirmation()
  });
}

async function handleRoomResetConfirm(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await interaction.editReply({
      content:
        context.message,
      embeds: [],
      components: []
    });

    deleteReplyLater(
      interaction,
      ERROR_DELETE_MS
    );

    return;
  }

  const remaining =
    useCooldown(
      'room_reset',
      interaction,
      3000
    );

  if (remaining > 0) {
    await interaction.editReply({
      content:
        '⏳ Hãy chờ một chút trước khi đặt lại phòng lần nữa.',
      embeds: [],
      components: []
    });

    deleteReplyLater(
      interaction,
      ERROR_DELETE_MS
    );

    return;
  }

  try {
    await resetRoomState(
      context.channel,
      context.owner.id
    );

    clearSelectedMember(
      interaction.guild.id,
      context.channel.id,
      context.owner.id
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    await sendActionLog(
      interaction.guild,
      '♻️',
      safeMemberName(
        context.owner
      ),
      `Đặt lại phòng ${context.channel.name}`
    );

    await interaction.editReply({
      content:
        '♻️ Đã đặt lại phòng.',
      embeds: [],
      components: []
    });

    deleteReplyLater(
      interaction,
      SUCCESS_DELETE_MS
    );
  } catch (error) {
    logError(
      'ROOM_RESET',
      error
    );

    await interaction.editReply({
      content:
        '❌ Không thể đặt lại phòng.',
      embeds: [],
      components: []
    });

    deleteReplyLater(
      interaction,
      ERROR_DELETE_MS
    );
  }
}

async function handleRoomResetCancel(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  await interaction.editReply({
    content:
      '✖️ Đã hủy đặt lại phòng.',
    embeds: [],
    components: []
  });

  deleteReplyLater(
    interaction,
    SUCCESS_DELETE_MS
  );
}

async function handleRoomRegionSelect(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempFollowUp(
      interaction,
      context.message,
      {
        error: true
      }
    );

    return;
  }

  const remaining =
    useCooldown(
      'room_region',
      interaction,
      2500
    );

  if (remaining > 0) {
    await tempFollowUp(
      interaction,
      '⏳ Thao tác khu vực quá nhanh. Hãy thử lại sau một chút.',
      {
        error: true
      }
    );

    return;
  }

  const selectedValue =
    interaction.values?.[0];

  if (!selectedValue) {
    await tempFollowUp(
      interaction,
      '❌ Khu vực được chọn không hợp lệ.',
      {
        error: true
      }
    );

    return;
  }

  try {
    const region =
      await validateVoiceRegion(
        selectedValue
      );

    if (
      selectedValue !==
        'automatic' &&
      !region
    ) {
      await tempFollowUp(
        interaction,
        '❌ Khu vực này không còn khả dụng. Danh sách đã được làm mới.',
        {
          error: true
        }
      );

      await refreshRoomPanelSafe(
        context.channel.id
      );

      return;
    }

    const targetRegion =
      selectedValue ===
      'automatic'
        ? null
        : region.id;

    await context.channel.setRTCRegion(
      targetRegion,
      `${BOT_NAME}: chủ phòng đổi khu vực`
    );

    let verified =
      await getGuildChannel(
        interaction.guild,
        context.channel.id
      );

    if (
      !verified ||
      verified.type !==
        ChannelType.GuildVoice
    ) {
      throw new Error(
        'ROOM_NOT_FOUND_AFTER_REGION_CHANGE'
      );
    }

    if (
      verified.rtcRegion !==
      targetRegion
    ) {
      try {
        verified =
          await interaction.guild.channels.fetch(
            context.channel.id,
            {
              force: true
            }
          );
      } catch {
      }
    }

    if (
      verified?.rtcRegion !==
      targetRegion
    ) {
      throw new Error(
        'REGION_VERIFY_FAILED'
      );
    }

    await refreshRoomPanelSafe(
      context.channel.id
    );

    const displayRegion =
      targetRegion ===
      null
        ? 'Tự động'
        : regionLabel(
            region
          );

    await sendActionLog(
      interaction.guild,
      '🌐',
      safeMemberName(
        context.owner
      ),
      `Đổi khu vực: ${displayRegion}`
    );

    await tempFollowUp(
      interaction,
      `🌐 Đã đổi khu vực: ${displayRegion}`
    );
  } catch (error) {
    logError(
      'ROOM_REGION',
      error
    );

    await tempFollowUp(
      interaction,
      '❌ Không thể thay đổi khu vực thoại.',
      {
        error: true
      }
    );
  }
}

async function handleRoomTransferButton(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempFollowUp(
      interaction,
      context.message,
      {
        error: true
      }
    );

    return;
  }

  const selected =
    await getRequiredSelectedMember(
      interaction,
      context
    );

  if (!selected.ok) {
    await tempFollowUp(
      interaction,
      selected.message,
      {
        error: true
      }
    );

    return;
  }

  const target =
    selected.member;

  if (
    target.voice?.channelId !==
    context.channel.id
  ) {
    clearSelectedMember(
      interaction.guild.id,
      context.channel.id,
      context.owner.id
    );

    await refreshRoomPanelSafe(
      context.channel.id
    ).catch(() => {});

    await tempFollowUp(
      interaction,
      `⚠️ ${safeMemberName(target)} không có mặt trong phòng này.`,
      {
        error: true
      }
    );

    return;
  }

  const existingPending =
    getPendingTransfer(
      context.channel.id
    );

  if (existingPending) {
    await tempFollowUp(
      interaction,
      '⏳ Phòng đang có một yêu cầu chuyển chủ chờ xác nhận.',
      {
        error: true
      }
    );

    return;
  }

  try {
    const targetOwnedRoom =
      await getOwnedRoom(
        interaction.guild.id,
        target.id
      );

    if (
      targetOwnedRoom &&
      String(
        targetOwnedRoom.channel_id
      ) !==
      context.channel.id
    ) {
      await tempFollowUp(
        interaction,
        `❌ ${safeMemberName(
          target
        )} đang sở hữu một phòng khác.`,
        {
          error: true
        }
      );

      return;
    }

    clearSelectedMember(
      interaction.guild.id,
      context.channel.id,
      context.owner.id
    );

    await createTransferRequest(
      interaction,
      context,
      target
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );
  } catch (error) {
    logError(
      'ROOM_TRANSFER_REQUEST',
      error
    );

    await tempFollowUp(
      interaction,
      '❌ Không thể tạo yêu cầu chuyển chủ.',
      {
        error: true
      }
    );
  }
}

function actionActorName(
  actor
) {
  if (!actor) {
    return BOT_NAME;
  }

  if (
    typeof actor ===
    'string'
  ) {
    return String(actor)
      .replace(
        /\r?\n/g,
        ' '
      )
      .trim()
      .slice(
        0,
        80
      );
  }

  return safeMemberName(
    actor
  );
}

async function getActionLogChannel(
  guild
) {
  const generator =
    await getGenerator(
      guild.id
    );

  if (
    !generator?.action_log_channel_id
  ) {
    return null;
  }

  const channel =
    await getGuildChannel(
      guild,
      String(
        generator.action_log_channel_id
      )
    );

  if (
    !channel ||
    channel.type !==
      ChannelType.GuildText
  ) {
    return null;
  }

  return channel;
}

async function sendActionLog(
  guild,
  emoji,
  actor,
  action
) {
  if (
    !guild ||
    !action
  ) {
    return null;
  }

  try {
    const channel =
      await getActionLogChannel(
        guild
      );

    if (!channel) {
      return null;
    }

    const actorName =
      actionActorName(
        actor
      );

    const cleanAction =
      String(action)
        .replace(
          /\r?\n/g,
          ' '
        )
        .replace(
          /\s+/g,
          ' '
        )
        .trim()
        .slice(
          0,
          1500
        );

    return await channel.send({
      content:
        `${emoji || '⚙️'} ${actorName} » ${cleanAction} • ${vietnamTime()}`,
      allowedMentions: {
        parse: []
      }
    });
  } catch (error) {
    logError(
      `ACTION_LOG:${guild?.id || 'UNKNOWN'}`,
      error
    );

    return null;
  }
}

function buildTransferRequestPayload({
  owner,
  target,
  expiresAt
}) {
  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'transfer_accept'
          )
          .setLabel(
            'Đồng ý'
          )
          .setEmoji(
            '👑'
          )
          .setStyle(
            ButtonStyle.Success
          ),

        new ButtonBuilder()
          .setCustomId(
            'transfer_decline'
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
      );

  return {
    content: [
      `👑 **${safeMemberName(
        owner
      )}** muốn chuyển quyền chủ phòng cho <@${target.id}>`,
      '',
      `⏳ Hết hạn ${relativeTimestamp(
        expiresAt
      )}`
    ].join('\n'),
    components: [
      row
    ],
    allowedMentions: {
      users: [
        target.id
      ],
      roles: [],
      repliedUser: false
    }
  };
}

async function editTransferResult(
  message,
  content,
  duration =
    SUCCESS_DELETE_MS
) {
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

    deleteMessageLater(
      message,
      duration
    );
  } catch {
  }
}

async function expireTransferRequest(
  channelId,
  expectedMessageId
) {
  const pending =
    getPendingTransfer(
      channelId
    );

  if (!pending) {
    return;
  }

  if (
    expectedMessageId &&
    pending.messageId !==
      expectedMessageId
  ) {
    return;
  }

  clearPendingTransfer(
    channelId
  );

  let message =
    pending.message ||
    null;

  if (!message) {
    const guild =
      client.guilds.cache.get(
        pending.guildId
      );

    const channel =
      guild
        ? await getGuildChannel(
            guild,
            pending.channelId
          )
        : null;

    if (channel) {
      message =
        await fetchMessageSafe(
          channel,
          pending.messageId
        );
    }
  }

  await editTransferResult(
    message,
    '⚠️ Chuyển chủ thất bại: người được chọn không phản hồi trong 60 giây.',
    SUCCESS_DELETE_MS
  );
}

async function createTransferRequest(
  interaction,
  context,
  target
) {
  const channel =
    context.channel;

  const existing =
    getPendingTransfer(
      channel.id
    );

  if (existing) {
    throw new Error(
      'TRANSFER_ALREADY_PENDING'
    );
  }

  if (
    target.voice?.channelId !==
    channel.id
  ) {
    throw new Error(
      'TRANSFER_TARGET_LEFT'
    );
  }

  const expiresAt =
    new Date(
      Date.now() +
      TRANSFER_TIMEOUT_MS
    );

  const message =
    await channel.send(
      buildTransferRequestPayload({
        owner:
          context.owner,
        target,
        expiresAt
      })
    );

  const timer =
    setTimeout(
      () => {
        expireTransferRequest(
          channel.id,
          message.id
        ).catch(
          error => {
            logError(
              `TRANSFER_EXPIRE:${channel.id}`,
              error
            );
          }
        );
      },
      TRANSFER_TIMEOUT_MS
    );

  timer.unref?.();

  pendingTransfers.set(
    transferKey(
      channel.id
    ),
    {
      guildId:
        interaction.guild.id,
      channelId:
        channel.id,
      ownerId:
        context.owner.id,
      targetId:
        target.id,
      messageId:
        message.id,
      message,
      expiresAt:
        expiresAt.getTime(),
      timer
    }
  );

  await tempFollowUp(
    interaction,
    `👑 Đã gửi yêu cầu chuyển chủ cho ${safeMemberName(
      target
    )}.`
  );
}

async function handleTransferAccept(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const pending =
    getPendingTransfer(
      interaction.channelId
    );

  if (!pending) {
    await tempFollowUp(
      interaction,
      '⌛ Yêu cầu chuyển chủ không còn hiệu lực.',
      {
        error: true
      }
    );

    return;
  }

  if (
    pending.messageId !==
    interaction.message.id
  ) {
    await tempFollowUp(
      interaction,
      '⌛ Đây không còn là yêu cầu chuyển chủ hiện tại.',
      {
        error: true
      }
    );

    return;
  }

  if (
    interaction.user.id !==
    pending.targetId
  ) {
    await tempFollowUp(
      interaction,
      '❌ Chỉ người được chọn mới có thể đồng ý.',
      {
        error: true
      }
    );

    return;
  }

  if (
    Date.now() >
    pending.expiresAt
  ) {
    await expireTransferRequest(
      pending.channelId,
      pending.messageId
    );

    return;
  }

  try {
    await withRoomLifecycleLock(
      pending.channelId,
      async () => {
        const room =
          await getRoom(
            pending.channelId
          );

        if (!room) {
          throw new Error(
            'TRANSFER_ROOM_MISSING'
          );
        }

        if (
          String(
            room.owner_id
          ) !==
          pending.ownerId
        ) {
          throw new Error(
            'TRANSFER_OWNER_CHANGED'
          );
        }

        const guild =
          interaction.guild;

        const channel =
          await getGuildChannel(
            guild,
            pending.channelId
          );

        if (
          !channel ||
          channel.type !==
            ChannelType.GuildVoice
        ) {
          throw new Error(
            'TRANSFER_CHANNEL_MISSING'
          );
        }

        const oldOwner =
          await getGuildMember(
            guild,
            pending.ownerId
          );

        const newOwner =
          await getGuildMember(
            guild,
            pending.targetId
          );

        if (!newOwner) {
          throw new Error(
            'TRANSFER_TARGET_MISSING'
          );
        }

        if (
          newOwner.voice?.channelId !==
          channel.id
        ) {
          throw new Error(
            'TRANSFER_TARGET_LEFT'
          );
        }

        if (
          !oldOwner ||
          oldOwner.voice?.channelId !==
          channel.id
        ) {
          throw new Error(
            'TRANSFER_OWNER_LEFT'
          );
        }

        const ownedRoom =
          await getOwnedRoom(
            guild.id,
            newOwner.id
          );

        if (
          ownedRoom &&
          String(
            ownedRoom.channel_id
          ) !==
          channel.id
        ) {
          throw new Error(
            'TRANSFER_TARGET_HAS_ROOM'
          );
        }

        const dbClient =
          await pool.connect();

        try {
          await dbClient.query(
            'BEGIN'
          );

          const locked =
            await dbClient.query(
              `
                SELECT *
                FROM rooms
                WHERE channel_id = $1
                FOR UPDATE
              `,
              [
                channel.id
              ]
            );

          const lockedRoom =
            locked.rows[0];

          if (!lockedRoom) {
            throw new Error(
              'TRANSFER_ROOM_MISSING'
            );
          }

          if (
            String(
              lockedRoom.owner_id
            ) !==
            pending.ownerId
          ) {
            throw new Error(
              'TRANSFER_OWNER_CHANGED'
            );
          }

          const duplicate =
            await dbClient.query(
              `
                SELECT channel_id
                FROM rooms
                WHERE
                  guild_id = $1
                  AND owner_id = $2
                  AND channel_id <> $3
                LIMIT 1
              `,
              [
                guild.id,
                newOwner.id,
                channel.id
              ]
            );

          if (
            duplicate.rowCount >
            0
          ) {
            throw new Error(
              'TRANSFER_TARGET_HAS_ROOM'
            );
          }

          await updateRoomOwner(
            channel.id,
            newOwner.id,
            dbClient
          );

          await dbClient.query(
            'COMMIT'
          );
        } catch (error) {
          await dbClient.query(
            'ROLLBACK'
          ).catch(
            () => {}
          );

          throw error;
        } finally {
          dbClient.release();
        }

        try {
          await grantOwnerPermissions(
            channel,
            newOwner
          );

          await removeOwnerPermissions(
            channel,
            oldOwner
          );

          await ensureBotRoomPermissions(
            channel
          );
        } catch (permissionError) {
          logError(
            `TRANSFER_PERMISSION:${channel.id}`,
            permissionError
          );

          try {
            await updateRoomOwner(
              channel.id,
              oldOwner.id
            );

            await grantOwnerPermissions(
              channel,
              oldOwner
            );

            await safeDeleteOverwrite(
              channel,
              newOwner.id,
              `${BOT_NAME}: hoàn tác chuyển chủ lỗi`
            );

            await ensureBotRoomPermissions(
              channel
            );
          } catch (rollbackError) {
            logError(
              `TRANSFER_ROLLBACK:${channel.id}`,
              rollbackError
            );
          }

          throw permissionError;
        }

        clearPendingTransfer(
          channel.id
        );

        clearSelectionsForChannel(
          guild.id,
          channel.id
        );

        clearRuntimeOwnerAbsenceTimer(
          channel.id
        );

        await deleteOwnerAbsence(
          channel.id
        ).catch(
          () => {}
        );

        await refreshRoomPanelSafe(
          channel.id
        );

        await sendActionLog(
          guild,
          '👑',
          safeMemberName(
            oldOwner
          ),
          `Chuyển chủ cho ${safeMemberName(
            newOwner
          )}`
        );

        await editTransferResult(
          interaction.message,
          `👑 ${safeMemberName(
            newOwner
          )} đã trở thành chủ phòng.`,
          SUCCESS_DELETE_MS
        );
      }
    );
  } catch (error) {
    logError(
      'TRANSFER_ACCEPT',
      error
    );

    clearPendingTransfer(
      interaction.channelId
    );

    let message =
      '❌ Không thể hoàn tất chuyển chủ.';

    if (
      error.message ===
      'TRANSFER_TARGET_LEFT'
    ) {
      message =
        '❌ Người nhận đã rời phòng. Yêu cầu chuyển chủ bị hủy.';
    } else if (
      error.message ===
      'TRANSFER_OWNER_LEFT'
    ) {
      message =
        '❌ Chủ phòng đã rời phòng. Yêu cầu chuyển chủ bị hủy.';
    } else if (
      error.message ===
      'TRANSFER_TARGET_HAS_ROOM'
    ) {
      message =
        '❌ Người nhận đang sở hữu một phòng khác.';
    } else if (
      error.message ===
      'TRANSFER_OWNER_CHANGED'
    ) {
      message =
        '⌛ Quyền chủ của phòng đã thay đổi. Yêu cầu cũ không còn hiệu lực.';
    }

    await editTransferResult(
      interaction.message,
      message,
      ERROR_DELETE_MS
    );
  }
}

async function handleTransferDecline(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  const pending =
    getPendingTransfer(
      interaction.channelId
    );

  if (!pending) {
    await tempFollowUp(
      interaction,
      '⌛ Yêu cầu chuyển chủ không còn hiệu lực.',
      {
        error: true
      }
    );

    return;
  }

  if (
    pending.messageId !==
    interaction.message.id
  ) {
    await tempFollowUp(
      interaction,
      '⌛ Đây không còn là yêu cầu chuyển chủ hiện tại.',
      {
        error: true
      }
    );

    return;
  }

  if (
    interaction.user.id !==
    pending.targetId
  ) {
    await tempFollowUp(
      interaction,
      '❌ Chỉ người được chọn mới có thể từ chối.',
      {
        error: true
      }
    );

    return;
  }

  clearPendingTransfer(
    interaction.channelId
  );

  const member =
    await getGuildMember(
      interaction.guild,
      interaction.user.id
    );

  await editTransferResult(
    interaction.message,
    `✖️ ${safeMemberName(
      member
    )} đã từ chối nhận quyền chủ.`,
    SUCCESS_DELETE_MS
  );
}

function compactLogText(
  value,
  maxLength =
    1200
) {
  const text =
    String(
      value || ''
    )
      .replace(
        /\r?\n/g,
        ' '
      )
      .replace(
        /\s+/g,
        ' '
      )
      .trim();

  if (
    text.length <=
    maxLength
  ) {
    return text;
  }

  return (
    `${text.slice(
      0,
      Math.max(
        0,
        maxLength - 1
      )
    )}…`
  );
}

function escapeLogQuote(
  value
) {
  return compactLogText(
    value
  )
    .replace(
      /\\/g,
      '\\\\'
    )
    .replace(
      /"/g,
      '\\"'
    );
}

function extractUrls(
  content
) {
  const text =
    String(
      content || ''
    );

  const matches =
    text.match(
      /https?:\/\/[^\s<>"']+/gi
    ) ||
    [];

  return Array.from(
    new Set(
      matches
    )
  ).slice(
    0,
    10
  );
}

function attachmentSummary(
  attachments
) {
  if (!attachments) {
    return [];
  }

  return Array.from(
    attachments.values()
  ).map(
    attachment => ({
      id:
        attachment.id,
      name:
        compactLogText(
          attachment.name ||
          'file',
          150
        ),
      url:
        attachment.url,
      size:
        Number(
          attachment.size ||
          0
        ),
      contentType:
        attachment.contentType ||
        null
    })
  );
}

async function getChatLogChannel(
  guild
) {
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
    await getGuildChannel(
      guild,
      String(
        generator.chat_log_channel_id
      )
    );

  if (
    !channel ||
    channel.type !==
      ChannelType.GuildText
  ) {
    return null;
  }

  return channel;
}

function estimatedDiscordUploadLimit(
  guild
) {
  if (
    guild?.premiumTier >=
    2
  ) {
    return (
      50 *
      1024 *
      1024
    );
  }

  return (
    10 *
    1024 *
    1024
  );
}
async function downloadAttachmentBuffer(
  attachment,
  maxBytes
) {
  if (
    !attachment?.url
  ) {
    throw new Error(
      'ATTACHMENT_URL_MISSING'
    );
  }

  if (
    attachment.size &&
    attachment.size >
    maxBytes
  ) {
    throw new Error(
      'ATTACHMENT_TOO_LARGE'
    );
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => {
        controller.abort();
      },
      15000
    );

  timeout.unref?.();

  try {
    const response =
      await fetch(
        attachment.url,
        {
          signal:
            controller.signal
        }
      );

    if (!response.ok) {
      throw new Error(
        `ATTACHMENT_HTTP_${response.status}`
      );
    }

    const contentLength =
      Number(
        response.headers.get(
          'content-length'
        ) ||
        0
      );

    if (
      contentLength &&
      contentLength >
      maxBytes
    ) {
      throw new Error(
        'ATTACHMENT_TOO_LARGE'
      );
    }

    const arrayBuffer =
      await response.arrayBuffer();

    const buffer =
      Buffer.from(
        arrayBuffer
      );

    if (
      buffer.length >
      maxBytes
    ) {
      throw new Error(
        'ATTACHMENT_TOO_LARGE'
      );
    }

    return buffer;
  } finally {
    clearTimeout(
      timeout
    );
  }
}

async function archiveAttachments(
  logChannel,
  sourceMessage,
  attachments
) {
  const items =
    attachmentSummary(
      attachments
    );

  if (
    items.length ===
    0
  ) {
    return {
      archived: [],
      failed: []
    };
  }

  const maxBytes =
    estimatedDiscordUploadLimit(
      sourceMessage.guild
    );

  const archived = [];
  const failed = [];

  for (
    const item
    of items
  ) {
    try {
      const buffer =
        await downloadAttachmentBuffer(
          item,
          maxBytes
        );

      const safeName =
        (
          item.name ||
          `file-${item.id}`
        ).slice(
          0,
          150
        );

      const archivedMessage =
        await logChannel.send({
          content:
            `📦 Bản lưu tệp từ <#${sourceMessage.channelId}> • ${vietnamTime(
              sourceMessage.createdAt ||
              new Date()
            )}`,
          files: [
            {
              attachment:
                buffer,
              name:
                safeName
            }
          ],
          allowedMentions: {
            parse: []
          }
        });

      archived.push({
        ...item,
        archivedMessageId:
          archivedMessage.id
      });
    } catch (error) {
      logError(
        `ARCHIVE_ATTACHMENT:${sourceMessage.id}:${item.id}`,
        error
      );

      failed.push({
        ...item,
        error:
          error?.message ||
          'ARCHIVE_FAILED'
      });
    }
  }

  return {
    archived,
    failed
  };
}

function messageAuthorName(
  message
) {
  if (
    message.member
  ) {
    return safeMemberName(
      message.member
    );
  }

  return compactLogText(
    message.author?.globalName ||
    message.author?.username ||
    'Không xác định',
    80
  );
}

async function sendChatCreateLog(
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

  if (
    message.channelId ===
    logChannel.id
  ) {
    return;
  }

  const authorName =
    messageAuthorName(
      message
    );

  const content =
    compactLogText(
      message.content,
      1200
    );

  const urls =
    extractUrls(
      message.content
    );

  const attachments =
    attachmentSummary(
      message.attachments
    );

  const lines = [];

  lines.push(
    `💬 ${authorName} » "${escapeLogQuote(
      content ||
      (
        attachments.length
          ? '[Tệp đính kèm]'
          : '[Không có nội dung văn bản]'
      )
    )}"`
  );

  if (
    urls.length >
    0
  ) {
    lines.push(
      `🔗 Liên kết: ${urls.join(
        ' • '
      )}`
    );
  }

  if (
    attachments.length >
    0
  ) {
    lines.push(
      `📎 Tệp đính kèm: ${attachments
        .map(
          item =>
            item.name
        )
        .join(' • ')}`
    );
  }

  lines.push(
    vietnamTime(
      message.createdAt ||
      new Date()
    )
  );

  await logChannel.send({
    content:
      lines.join(
        '\n'
      ),
    allowedMentions: {
      parse: []
    }
  });

  if (
    attachments.length >
    0
  ) {
    const archiveResult =
      await archiveAttachments(
        logChannel,
        message,
        message.attachments
      );

    if (
      archiveResult.failed.length >
      0
    ) {
      const failedLines =
        archiveResult.failed
          .map(
            item =>
              `• ${item.name} — ${item.url || 'Không có URL'}`
          )
          .join(
            '\n'
          );

      await logChannel.send({
        content: [
          '⚠️ Không thể lưu bản sao của một số tệp. Giữ lại thông tin/URL gốc:',
          failedLines
        ].join('\n'),
        allowedMentions: {
          parse: []
        }
      });
    }
  }
}

async function hydratePartialMessage(
  message
) {
  if (!message) {
    return null;
  }

  if (
    !message.partial
  ) {
    return message;
  }

  try {
    return await message.fetch();
  } catch {
    return message;
  }
}

async function sendChatEditLog(
  oldMessage,
  newMessage
) {
  newMessage =
    await hydratePartialMessage(
      newMessage
    );

  if (
    !newMessage ||
    !newMessage.guild ||
    newMessage.author?.bot
  ) {
    return;
  }

  const logChannel =
    await getChatLogChannel(
      newMessage.guild
    );

  if (
    !logChannel ||
    newMessage.channelId ===
    logChannel.id
  ) {
    return;
  }

  const before =
    compactLogText(
      oldMessage?.content,
      900
    );

  const after =
    compactLogText(
      newMessage.content,
      900
    );

  if (
    before ===
      after
  ) {
    return;
  }

  const authorName =
    messageAuthorName(
      newMessage
    );

  await logChannel.send({
    content: [
      `✏️ ${authorName} » Chỉnh sửa tin nhắn`,
      `Trước: "${escapeLogQuote(
        before ||
        '[Không lấy được nội dung cũ]'
      )}"`,
      `Sau: "${escapeLogQuote(
        after ||
        '[Không có nội dung]'
      )}"`,
      vietnamTime()
    ].join('\n'),
    allowedMentions: {
      parse: []
    }
  });
}

async function sendChatDeleteLog(
  message
) {
  if (
    !message ||
    !message.guild
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

  if (
    !logChannel ||
    message.channelId ===
    logChannel.id
  ) {
    return;
  }

  const authorName =
    messageAuthorName(
      message
    );

  const content =
    compactLogText(
      message.content,
      1200
    );

  const attachments =
    attachmentSummary(
      message.attachments
    );

  const lines = [
    `🗑️ ${authorName} » Xóa tin nhắn`,
    `"${escapeLogQuote(
      content ||
      (
        attachments.length
          ? '[Tin nhắn có tệp đính kèm]'
          : '[Không lấy được nội dung]'
      )
    )}"`
  ];

  if (
    attachments.length >
    0
  ) {
    lines.push(
      `📎 Tệp: ${attachments
        .map(
          item =>
            item.name
        )
        .join(' • ')}`
    );
  }

  lines.push(
    vietnamTime()
  );

  await logChannel.send({
    content:
      lines.join(
        '\n'
      ),
    allowedMentions: {
      parse: []
    }
  });
}

async function sendBulkDeleteLog(
  messages,
  channel
) {
  if (
    !channel?.guild
  ) {
    return;
  }

  const logChannel =
    await getChatLogChannel(
      channel.guild
    );

  if (
    !logChannel ||
    channel.id ===
    logChannel.id
  ) {
    return;
  }

  const userMessages =
    Array.from(
      messages?.values?.() ||
      []
    ).filter(
      message =>
        !message.author?.bot
    );

  if (
    userMessages.length ===
    0
  ) {
    return;
  }

  const samples =
    userMessages
      .slice(
        0,
        10
      )
      .map(
        message => {
          const author =
            messageAuthorName(
              message
            );

          const content =
            compactLogText(
              message.content,
              150
            );

          return (
            `• ${author}: "${escapeLogQuote(
              content ||
              '[Không lấy được nội dung]'
            )}"`
          );
        }
      );

  const extra =
    userMessages.length >
    samples.length
      ? `\n… và ${
          userMessages.length -
          samples.length
        } tin nhắn khác`
      : '';

  await logChannel.send({
    content: [
      `🗑️ Xóa hàng loạt ${userMessages.length} tin nhắn tại <#${channel.id}>`,
      ...samples,
      extra,
      vietnamTime()
    ]
      .filter(Boolean)
      .join('\n'),
    allowedMentions: {
      parse: []
    }
  });
}

async function ensureOwnershipTrackingTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_presence (
      guild_id BIGINT NOT NULL,
      channel_id BIGINT NOT NULL,
      member_id BIGINT NOT NULL,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (channel_id, member_id)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_room_presence_channel_joined
    ON room_presence (channel_id, joined_at ASC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS owner_absences (
      channel_id BIGINT PRIMARY KEY,
      guild_id BIGINT NOT NULL,
      owner_id BIGINT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deadline_at TIMESTAMPTZ NOT NULL,
      notice_message_id BIGINT
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_owner_absences_deadline
    ON owner_absences (deadline_at)
  `);
}

async function recordMemberPresence(
  guildId,
  channelId,
  memberId,
  joinedAt = new Date()
) {
  const result =
    await pool.query(
      `
        INSERT INTO room_presence (
          guild_id,
          channel_id,
          member_id,
          joined_at
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (channel_id, member_id)
        DO NOTHING
        RETURNING *
      `,
      [
        guildId,
        channelId,
        memberId,
        joinedAt
      ]
    );

  return result.rows[0] || null;
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
      channelId,
      memberId
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
        ORDER BY joined_at ASC, member_id ASC
      `,
      [
        channelId
      ]
    );

  return result.rows;
}

async function deleteRoomPresence(
  channelId,
  dbClient = pool
) {
  await dbClient.query(
    `
      DELETE FROM room_presence
      WHERE channel_id = $1
    `,
    [
      channelId
    ]
  );
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
        INSERT INTO owner_absences (
          guild_id,
          channel_id,
          owner_id,
          started_at,
          deadline_at,
          notice_message_id
        )
        VALUES (
          $1,
          $2,
          $3,
          NOW(),
          $4,
          $5
        )
        ON CONFLICT (channel_id)
        DO UPDATE SET
          guild_id = EXCLUDED.guild_id,
          owner_id = EXCLUDED.owner_id,
          deadline_at = EXCLUDED.deadline_at,
          notice_message_id = EXCLUDED.notice_message_id
        RETURNING *
      `,
      [
        guildId,
        channelId,
        ownerId,
        deadlineAt,
        noticeMessageId
      ]
    );

  return result.rows[0] || null;
}

async function getOwnerAbsence(
  channelId
) {
  const result =
    await pool.query(
      `
        SELECT *
        FROM owner_absences
        WHERE channel_id = $1
        LIMIT 1
      `,
      [
        channelId
      ]
    );

  return result.rows[0] || null;
}

async function setOwnerAbsenceNotice(
  channelId,
  messageId
) {
  await pool.query(
    `
      UPDATE owner_absences
      SET notice_message_id = $2
      WHERE channel_id = $1
    `,
    [
      channelId,
      messageId
    ]
  );
}

async function deleteOwnerAbsence(
  channelId,
  dbClient = pool
) {
  await dbClient.query(
    `
      DELETE FROM owner_absences
      WHERE channel_id = $1
    `,
    [
      channelId
    ]
  );
}

async function deleteOwnershipTracking(
  channelId,
  dbClient = pool
) {
  await dbClient.query(
    `
      DELETE FROM room_presence
      WHERE channel_id = $1
    `,
    [
      channelId
    ]
  );

  await dbClient.query(
    `
      DELETE FROM owner_absences
      WHERE channel_id = $1
    `,
    [
      channelId
    ]
  );
}

function clearRuntimeOwnerAbsenceTimer(
  channelId
) {
  const key =
    String(
      channelId
    );

  const timer =
    ownerAbsenceTimers.get(
      key
    );

  if (timer) {
    clearTimeout(
      timer
    );

    ownerAbsenceTimers.delete(
      key
    );
  }
}

async function withRoomLifecycleLock(
  channelId,
  task
) {
  return withLock(
    roomLifecycleLocks,
    String(
      channelId
    ),
    task
  );
}

async function deleteOwnerAbsenceNotice(
  channel,
  absence
) {
  if (
    !channel ||
    !absence?.notice_message_id
  ) {
    return;
  }

  const message =
    await fetchMessageSafe(
      channel,
      String(
        absence.notice_message_id
      )
    );

  if (!message) {
    return;
  }

  try {
    await message.delete();
  } catch {
  }
}

async function cancelOwnerAbsence(
  channel,
  {
    returned = false
  } = {}
) {
  if (!channel) {
    return;
  }

  clearRuntimeOwnerAbsenceTimer(
    channel.id
  );

  const absence =
    await getOwnerAbsence(
      channel.id
    );

  if (!absence) {
    return;
  }

  await deleteOwnerAbsenceNotice(
    channel,
    absence
  );

  await deleteOwnerAbsence(
    channel.id
  );

  if (returned) {
    const room =
      await getRoom(
        channel.id
      );

    if (room) {
      const owner =
        await getGuildMember(
          channel.guild,
          String(
            room.owner_id
          )
        );

      await sendTemporaryChannelNotice(
        channel,
        owner
          ? `👑 ${safeMemberName(owner)} đã quay lại. Quyền chủ phòng được giữ nguyên.`
          : '👑 Chủ phòng đã quay lại. Quyền chủ phòng được giữ nguyên.',
        NOTICE_DELETE_MS
      );
    }
  }
}

async function sendOwnerAbsenceNotice(
  channel,
  owner,
  deadlineAt
) {
  const unix =
    Math.floor(
      new Date(
        deadlineAt
      ).getTime() /
      1000
    );

  try {
    return await channel.send({
      content: [
        `👑 **${safeMemberName(owner)}** đã rời phòng.`,
        `⏳ Quyền chủ sẽ tự động chuyển cho thành viên đã ở phòng lâu nhất sau <t:${unix}:R>.`,
        'Nếu chủ phòng quay lại trước thời hạn, việc chuyển chủ sẽ được hủy.'
      ].join('\n'),
      allowedMentions: {
        parse: []
      }
    });
  } catch (error) {
    logError(
      `OWNER_ABSENCE_NOTICE:${channel.id}`,
      error
    );

    return null;
  }
}

async function scheduleOwnerAbsenceTimer(
  channelId,
  deadlineAt
) {
  clearRuntimeOwnerAbsenceTimer(
    channelId
  );

  const deadline =
    new Date(
      deadlineAt
    ).getTime();

  const delay =
    Math.max(
      0,
      deadline -
      Date.now()
    );

  const timer =
    setTimeout(
      () => {
        ownerAbsenceTimers.delete(
          String(
            channelId
          )
        );

        processOwnerAbsenceExpiry(
          String(
            channelId
          )
        ).catch(
          error => {
            logError(
              `OWNER_ABSENCE_EXPIRE:${channelId}`,
              error
            );
          }
        );
      },
      Math.min(
        delay,
        2147483647
      )
    );

  timer.unref?.();

  ownerAbsenceTimers.set(
    String(
      channelId
    ),
    timer
  );
}

async function beginOwnerAbsence(
  channel,
  room,
  owner
) {
  if (
    !channel ||
    !room ||
    !owner
  ) {
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
    await cancelOwnerAbsence(
      channel
    ).catch(
      () => {}
    );

    return;
  }

  const existing =
    await getOwnerAbsence(
      channel.id
    );

  if (
    existing &&
    String(
      existing.owner_id
    ) ===
    String(
      room.owner_id
    )
  ) {
    await scheduleOwnerAbsenceTimer(
      channel.id,
      existing.deadline_at
    );

    return;
  }

  if (existing) {
    await deleteOwnerAbsenceNotice(
      channel,
      existing
    );

    await deleteOwnerAbsence(
      channel.id
    );
  }

  clearPendingTransfer(
    channel.id
  );

  const deadlineAt =
    new Date(
      Date.now() +
      OWNER_ABSENCE_GRACE_MS
    );

  const absence =
    await saveOwnerAbsence({
      guildId:
        channel.guild.id,
      channelId:
        channel.id,
      ownerId:
        room.owner_id,
      deadlineAt
    });

  const notice =
    await sendOwnerAbsenceNotice(
      channel,
      owner,
      deadlineAt
    );

  if (notice) {
    await setOwnerAbsenceNotice(
      channel.id,
      notice.id
    );
  }

  await scheduleOwnerAbsenceTimer(
    channel.id,
    absence.deadline_at
  );
}

async function memberOwnsOtherRoom(
  guildId,
  memberId,
  currentChannelId
) {
  const owned =
    await getOwnedRoom(
      guildId,
      memberId
    );

  return Boolean(
    owned &&
    String(
      owned.channel_id
    ) !==
      String(
        currentChannelId
      )
  );
}

async function chooseAutomaticOwner(
  channel,
  oldOwnerId
) {
  await syncCurrentRoomPresence(
    channel
  );

  const presence =
    await getRoomPresence(
      channel.id
    );

  const humans =
    humanMembers(
      channel
    );

  const humansById =
    new Map(
      humans.map(
        member => [
          member.id,
          member
        ]
      )
    );

  for (
    const row
    of presence
  ) {
    const memberId =
      String(
        row.member_id
      );

    if (
      memberId ===
      String(
        oldOwnerId
      )
    ) {
      continue;
    }

    const member =
      humansById.get(
        memberId
      );

    if (
      !member ||
      member.user.bot
    ) {
      continue;
    }

    const ownsOther =
      await memberOwnsOtherRoom(
        channel.guild.id,
        member.id,
        channel.id
      );

    if (ownsOther) {
      continue;
    }

    return member;
  }

  return null;
}

async function applyAutomaticOwnershipTransfer(
  channel,
  room,
  oldOwnerId,
  newOwner
) {
  const oldOwner =
    await getGuildMember(
      channel.guild,
      String(
        oldOwnerId
      )
    );

  const dbClient =
    await pool.connect();

  try {
    await dbClient.query(
      'BEGIN'
    );

    const lockedResult =
      await dbClient.query(
        `
          SELECT *
          FROM rooms
          WHERE channel_id = $1
          FOR UPDATE
        `,
        [
          channel.id
        ]
      );

    const lockedRoom =
      lockedResult.rows[0];

    if (!lockedRoom) {
      throw new Error(
        'AUTO_TRANSFER_ROOM_MISSING'
      );
    }

    if (
      String(
        lockedRoom.owner_id
      ) !==
      String(
        oldOwnerId
      )
    ) {
      throw new Error(
        'AUTO_TRANSFER_OWNER_CHANGED'
      );
    }

    const duplicate =
      await dbClient.query(
        `
          SELECT channel_id
          FROM rooms
          WHERE
            guild_id = $1
            AND owner_id = $2
            AND channel_id <> $3
          LIMIT 1
        `,
        [
          channel.guild.id,
          newOwner.id,
          channel.id
        ]
      );

    if (
      duplicate.rowCount >
      0
    ) {
      throw new Error(
        'AUTO_TRANSFER_TARGET_HAS_ROOM'
      );
    }

    await updateRoomOwner(
      channel.id,
      newOwner.id,
      dbClient
    );

    await deleteOwnerAbsence(
      channel.id,
      dbClient
    );

    await dbClient.query(
      'COMMIT'
    );
  } catch (error) {
    await dbClient.query(
      'ROLLBACK'
    ).catch(
      () => {}
    );

    throw error;
  } finally {
    dbClient.release();
  }

  try {
    await grantOwnerPermissions(
      channel,
      newOwner
    );

    if (oldOwner) {
      await removeOwnerPermissions(
        channel,
        oldOwner
      );
    } else {
      await safeDeleteOverwrite(
        channel,
        String(
          oldOwnerId
        ),
        `${BOT_NAME}: thu hồi quyền chủ cũ tự động`
      );
    }

    await ensureBotRoomPermissions(
      channel
    );
  } catch (permissionError) {
    logError(
      `AUTO_TRANSFER_PERMISSION:${channel.id}`,
      permissionError
    );

    try {
      await updateRoomOwner(
        channel.id,
        oldOwnerId
      );

      if (oldOwner) {
        await grantOwnerPermissions(
          channel,
          oldOwner
        );
      }

      await safeDeleteOverwrite(
        channel,
        newOwner.id,
        `${BOT_NAME}: hoàn tác chuyển chủ tự động`
      );

      await ensureBotRoomPermissions(
        channel
      );

      const retryDeadline =
        new Date(
          Date.now() +
          AUTO_TRANSFER_RETRY_MS
        );

      await saveOwnerAbsence({
        guildId:
          channel.guild.id,
        channelId:
          channel.id,
        ownerId:
          oldOwnerId,
        deadlineAt:
          retryDeadline
      });

      await scheduleOwnerAbsenceTimer(
        channel.id,
        retryDeadline
      );
    } catch (rollbackError) {
      logError(
        `AUTO_TRANSFER_ROLLBACK:${channel.id}`,
        rollbackError
      );
    }

    throw permissionError;
  }

  clearPendingTransfer(
    channel.id
  );

  clearSelectionsForChannel(
    channel.guild.id,
    channel.id
  );

  clearRuntimeOwnerAbsenceTimer(
    channel.id
  );

  await refreshRoomPanelSafe(
    channel.id
  );

  await sendActionLog(
    channel.guild,
    '👑',
    BOT_NAME,
    `Tự động chuyển chủ phòng ${channel.name} cho ${safeMemberName(
      newOwner
    )}`
  );

  await sendTemporaryChannelNotice(
    channel,
    `👑 ${safeMemberName(
      newOwner
    )} đã được chọn làm chủ phòng mới.`,
    NOTICE_DELETE_MS
  );
}

async function processOwnerAbsenceExpiry(
  channelId
) {
  await withRoomLifecycleLock(
    channelId,
    async () => {
      const absence =
        await getOwnerAbsence(
          channelId
        );

      if (!absence) {
        return;
      }

      const deadline =
        new Date(
          absence.deadline_at
        ).getTime();

      if (
        deadline >
        Date.now()
      ) {
        await scheduleOwnerAbsenceTimer(
          channelId,
          absence.deadline_at
        );

        return;
      }

      const room =
        await getRoom(
          channelId
        );

      if (!room) {
        await deleteOwnershipTracking(
          channelId
        );

        return;
      }

      if (
        String(
          room.owner_id
        ) !==
        String(
          absence.owner_id
        )
      ) {
        await deleteOwnerAbsence(
          channelId
        );

        return;
      }

      const guild =
        client.guilds.cache.get(
          String(
            room.guild_id
          )
        );

      if (!guild) {
        const retry =
          new Date(
            Date.now() +
            AUTO_TRANSFER_RETRY_MS
          );

        await saveOwnerAbsence({
          guildId:
            room.guild_id,
          channelId,
          ownerId:
            room.owner_id,
          deadlineAt:
            retry,
          noticeMessageId:
            absence.notice_message_id
        });

        await scheduleOwnerAbsenceTimer(
          channelId,
          retry
        );

        return;
      }

      const channel =
        await getGuildChannel(
          guild,
          channelId
        );

      if (
        !channel ||
        channel.type !==
          ChannelType.GuildVoice
      ) {
        await deleteOwnershipTracking(
          channelId
        );

        await deleteRoomRecord(
          channelId
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
        await deleteOwnerAbsenceNotice(
          channel,
          absence
        );

        await deleteOwnerAbsence(
          channel.id
        );

        scheduleEmptyRoomCheck(
          channel.id,
          0
        );

        return;
      }

      const owner =
        await getGuildMember(
          guild,
          String(
            room.owner_id
          )
        );

      if (
        owner &&
        owner.voice?.channelId ===
          channel.id
      ) {
        await cancelOwnerAbsence(
          channel,
          {
            returned: true
          }
        );

        return;
      }

      const candidate =
        await chooseAutomaticOwner(
          channel,
          room.owner_id
        );

      if (!candidate) {
        await deleteOwnerAbsenceNotice(
          channel,
          absence
        );

        await sendTemporaryChannelNotice(
          channel,
          '⚠️ Chưa có thành viên đủ điều kiện nhận quyền chủ. Voice HDK sẽ tiếp tục kiểm tra tự động.',
          NOTICE_DELETE_MS
        );

        const retryDeadline =
          new Date(
            Date.now() +
            AUTO_TRANSFER_RETRY_MS
          );

        const updated =
          await saveOwnerAbsence({
            guildId:
              guild.id,
            channelId:
              channel.id,
            ownerId:
              room.owner_id,
            deadlineAt:
              retryDeadline
          });

        const retryNotice =
          await sendOwnerAbsenceNotice(
            channel,
            owner || {
              displayName:
                'Chủ phòng'
            },
            retryDeadline
          );

        if (retryNotice) {
          await setOwnerAbsenceNotice(
            channel.id,
            retryNotice.id
          );
        }

        await scheduleOwnerAbsenceTimer(
          channel.id,
          updated.deadline_at
        );

        return;
      }

      await deleteOwnerAbsenceNotice(
        channel,
        absence
      );

      await applyAutomaticOwnershipTransfer(
        channel,
        room,
        room.owner_id,
        candidate
      );
    }
  );
}

async function handleOwnerVoiceTransition(
  oldState,
  newState
) {
  const member =
    oldState.member ||
    newState.member;

  if (
    !member ||
    member.user?.bot
  ) {
    return;
  }

  if (
    oldState.channelId &&
    oldState.channelId !==
      newState.channelId
  ) {
    const oldRoom =
      await getRoom(
        oldState.channelId
      );

    if (oldRoom) {
      await removeMemberPresence(
        oldState.channelId,
        member.id
      );

      if (
        String(
          oldRoom.owner_id
        ) ===
        member.id
      ) {
        const oldChannel =
          oldState.channel ||
          await getGuildChannel(
            oldState.guild,
            oldState.channelId
          );

        if (
          oldChannel &&
          oldChannel.type ===
            ChannelType.GuildVoice
        ) {
          const humans =
            humanMembers(
              oldChannel
            );

          if (
            humans.length >
            0
          ) {
            await beginOwnerAbsence(
              oldChannel,
              oldRoom,
              member
            );
          }
        }
      }
    }
  }

  if (
    newState.channelId &&
    oldState.channelId !==
      newState.channelId
  ) {
    const newRoom =
      await getRoom(
        newState.channelId
      );

    if (newRoom) {
      await recordMemberPresence(
        newState.guild.id,
        newState.channelId,
        member.id,
        new Date()
      );

      if (
        String(
          newRoom.owner_id
        ) ===
        member.id
      ) {
        const newChannel =
          newState.channel ||
          await getGuildChannel(
            newState.guild,
            newState.channelId
          );

        if (newChannel) {
          await cancelOwnerAbsence(
            newChannel,
            {
              returned: true
            }
          );
        }
      }
    }
  }
}

const slashCommands = [
  new SlashCommandBuilder()
    .setName(
      'setup'
    )
    .setDescription(
      'Cài đặt hoặc cài đặt lại Voice HDK'
    ),

  new SlashCommandBuilder()
    .setName(
      'fixmenu'
    )
    .setDescription(
      'Khôi phục bảng điều khiển phòng Voice HDK'
    ),

  new SlashCommandBuilder()
    .setName(
      'claim'
    )
    .setDescription(
      'Nhận quyền chủ của phòng khi chủ cũ không còn'
    ),

  new SlashCommandBuilder()
    .setName(
      'doctor'
    )
    .setDescription(
      'Kiểm tra trạng thái hệ thống Voice HDK'
    ),

  new SlashCommandBuilder()
    .setName(
      'reset'
    )
    .setDescription(
      'Xóa sạch dữ liệu và tài nguyên Voice HDK của server này'
    )
].map(
  command =>
    command.toJSON()
);
async function registerSlashCommands() {
  if (
    !client.application
  ) {
    throw new Error(
      'CLIENT_APPLICATION_NOT_READY'
    );
  }

  await client.application.commands.set(
    slashCommands
  );

  for (
    const guild
    of client.guilds.cache.values()
  ) {
    try {
      const guildCommands =
        await guild.commands.fetch();

      for (
        const command
        of guildCommands.values()
      ) {
        if (
          command.name === 'panel' ||
          command.name === 'fixmenu'
        ) {
          await command.delete();
        }
      }
    } catch (error) {
      logError(
        `CLEAN_STALE_GUILD_COMMANDS:${guild.id}`,
        error
      );
    }
  }
}

async function handlePanelCommand(
  interaction
) {
  await safeDeferReply(
    interaction,
    true
  );

  if (
    !interaction.guild
  ) {
    await tempReply(
      interaction,
      '❌ Lệnh này chỉ sử dụng trong server.',
      {
        error: true
      }
    );

    return;
  }

  const member =
    await getGuildMember(
      interaction.guild,
      interaction.user.id
    );

  const channel =
    member?.voice?.channel;

  if (
    !channel ||
    channel.type !==
      ChannelType.GuildVoice
  ) {
    await tempReply(
      interaction,
      '❌ Bạn cần ở trong một phòng Voice HDK.',
      {
        error: true
      }
    );

    return;
  }

  const room =
    await getRoom(
      channel.id
    );

  if (!room) {
    await tempReply(
      interaction,
      '❌ Phòng hiện tại không phải phòng do Voice HDK quản lý.',
      {
        error: true
      }
    );

    return;
  }

  if (
    String(
      room.owner_id
    ) !==
    interaction.user.id
  ) {
    await tempReply(
      interaction,
      '❌ Chỉ chủ phòng mới có thể khôi phục bảng điều khiển.',
      {
        error: true
      }
    );

    return;
  }

  try {
    await refreshRoomPanelSafe(
      channel.id,
      {
        forceRebuild: true
      }
    );

    await tempReply(
      interaction,
      '✅ Đã khôi phục bảng điều khiển phòng.'
    );
  } catch (error) {
    logError(
      'PANEL_COMMAND',
      error
    );

    await tempReply(
      interaction,
      '❌ Không thể khôi phục bảng điều khiển.',
      {
        error: true
      }
    );
  }
}

async function handleClaimCommand(
  interaction
) {
  await safeDeferReply(
    interaction,
    true
  );

  if (
    !interaction.guild
  ) {
    await tempReply(
      interaction,
      '❌ Lệnh này chỉ sử dụng trong server.',
      {
        error: true
      }
    );

    return;
  }

  const member =
    await getGuildMember(
      interaction.guild,
      interaction.user.id
    );

  const channel =
    member?.voice?.channel;

  if (
    !member ||
    !channel ||
    channel.type !==
      ChannelType.GuildVoice
  ) {
    await tempReply(
      interaction,
      '❌ Bạn cần ở trong phòng Voice HDK muốn nhận quyền chủ.',
      {
        error: true
      }
    );

    return;
  }

  try {
    await withRoomLifecycleLock(
      channel.id,
      async () => {
        const room =
          await getRoom(
            channel.id
          );

        if (!room) {
          throw new Error(
            'CLAIM_NOT_MANAGED'
          );
        }

        if (
          String(
            room.owner_id
          ) ===
          member.id
        ) {
          throw new Error(
            'CLAIM_ALREADY_OWNER'
          );
        }

        const absence =
          await getOwnerAbsence(
            channel.id
          );

        if (absence) {
          throw new Error(
            'CLAIM_GRACE_ACTIVE'
          );
        }

        const oldOwner =
          await getGuildMember(
            interaction.guild,
            String(
              room.owner_id
            )
          );

        if (
          oldOwner &&
          oldOwner.voice?.channelId ===
            channel.id
        ) {
          throw new Error(
            'CLAIM_OWNER_PRESENT'
          );
        }

        const owned =
          await getOwnedRoom(
            interaction.guild.id,
            member.id
          );

        if (
          owned &&
          String(
            owned.channel_id
          ) !==
          channel.id
        ) {
          throw new Error(
            'CLAIM_HAS_ROOM'
          );
        }

        const dbClient =
          await pool.connect();

        try {
          await dbClient.query(
            'BEGIN'
          );

          const locked =
            await dbClient.query(
              `
                SELECT *
                FROM rooms
                WHERE channel_id = $1
                FOR UPDATE
              `,
              [
                channel.id
              ]
            );

          const lockedRoom =
            locked.rows[0];

          if (!lockedRoom) {
            throw new Error(
              'CLAIM_NOT_MANAGED'
            );
          }

          const activeAbsence =
            await dbClient.query(
              `
                SELECT channel_id
                FROM owner_absences
                WHERE channel_id = $1
                LIMIT 1
              `,
              [
                channel.id
              ]
            );

          if (
            activeAbsence.rowCount >
            0
          ) {
            throw new Error(
              'CLAIM_GRACE_ACTIVE'
            );
          }

          const duplicate =
            await dbClient.query(
              `
                SELECT channel_id
                FROM rooms
                WHERE
                  guild_id = $1
                  AND owner_id = $2
                  AND channel_id <> $3
                LIMIT 1
              `,
              [
                interaction.guild.id,
                member.id,
                channel.id
              ]
            );

          if (
            duplicate.rowCount >
            0
          ) {
            throw new Error(
              'CLAIM_HAS_ROOM'
            );
          }

          await updateRoomOwner(
            channel.id,
            member.id,
            dbClient
          );

          await dbClient.query(
            'COMMIT'
          );
        } catch (error) {
          await dbClient.query(
            'ROLLBACK'
          ).catch(
            () => {}
          );

          throw error;
        } finally {
          dbClient.release();
        }

        try {
          await grantOwnerPermissions(
            channel,
            member
          );

          if (oldOwner) {
            await removeOwnerPermissions(
              channel,
              oldOwner
            );
          } else {
            await safeDeleteOverwrite(
              channel,
              String(
                room.owner_id
              ),
              `${BOT_NAME}: thu hồi chủ cũ khi claim`
            );
          }

          await ensureBotRoomPermissions(
            channel
          );
        } catch (permissionError) {
          try {
            await updateRoomOwner(
              channel.id,
              room.owner_id
            );

            if (oldOwner) {
              await grantOwnerPermissions(
                channel,
                oldOwner
              );
            }

            await safeDeleteOverwrite(
              channel,
              member.id,
              `${BOT_NAME}: hoàn tác claim lỗi`
            );

            await ensureBotRoomPermissions(
              channel
            );
          } catch (rollbackError) {
            logError(
              `CLAIM_ROLLBACK:${channel.id}`,
              rollbackError
            );
          }

          throw permissionError;
        }

        clearPendingTransfer(
          channel.id
        );

        clearSelectionsForChannel(
          interaction.guild.id,
          channel.id
        );

        await refreshRoomPanelSafe(
          channel.id
        );

        await sendActionLog(
          interaction.guild,
          '👑',
          safeMemberName(
            member
          ),
          `Nhận quyền chủ phòng ${channel.name}`
        );
      }
    );

    await tempReply(
      interaction,
      '👑 Bạn đã trở thành chủ phòng.'
    );
  } catch (error) {
    logError(
      'CLAIM_COMMAND',
      error
    );

    let message =
      '❌ Không thể nhận quyền chủ phòng.';

    if (
      error.message ===
      'CLAIM_GRACE_ACTIVE'
    ) {
      const absence =
        await getOwnerAbsence(
          channel.id
        ).catch(
          () => null
        );

      if (absence) {
        message =
          `⏳ Chủ phòng đang trong thời gian bảo lưu quyền. Hệ thống sẽ tự xử lý ${relativeTimestamp(
            absence.deadline_at
          )}.`;
      } else {
        message =
          '⏳ Phòng đang trong thời gian bảo lưu quyền chủ.';
      }
    } else if (
      error.message ===
      'CLAIM_OWNER_PRESENT'
    ) {
      message =
        '❌ Chủ phòng hiện vẫn đang ở trong phòng.';
    } else if (
      error.message ===
      'CLAIM_ALREADY_OWNER'
    ) {
      message =
        '👑 Bạn đã là chủ phòng này.';
    } else if (
      error.message ===
      'CLAIM_HAS_ROOM'
    ) {
      message =
        '❌ Bạn đang sở hữu một phòng khác.';
    } else if (
      error.message ===
      'CLAIM_NOT_MANAGED'
    ) {
      message =
        '❌ Phòng hiện tại không do Voice HDK quản lý.';
    }

    await tempReply(
      interaction,
      message,
      {
        error:
          error.message !==
          'CLAIM_ALREADY_OWNER'
      }
    );
  }
}

function doctorLine(
  ok,
  label,
  detail = ''
) {
  return (
    `${ok ? '✅' : '❌'} ${label}${
      detail
        ? ` — ${detail}`
        : ''
    }`
  );
}
async function handleDoctorCommand(
  interaction
) {
  await safeDeferReply(
    interaction,
    true
  );

  if (
    !interaction.guild
  ) {
    await tempReply(
      interaction,
      '❌ Lệnh này chỉ sử dụng trong server.',
      {
        error: true
      }
    );

    return;
  }

  if (
    !canManageSetup(
      interaction
    )
  ) {
    await tempReply(
      interaction,
      '❌ Bạn cần quyền Quản lý Server để sử dụng `/doctor`.',
      {
        error: true
      }
    );

    return;
  }

  const lines = [];

  try {
    const db =
      await pool.query(
        'SELECT NOW() AS now'
      );

    lines.push(
      doctorLine(
        Boolean(
          db.rows[0]?.now
        ),
        'PostgreSQL'
      )
    );
  } catch {
    lines.push(
      doctorLine(
        false,
        'PostgreSQL',
        'Không kết nối được'
      )
    );
  }

  lines.push(
    doctorLine(
      client.isReady(),
      'Discord Gateway',
      client.isReady()
        ? `Ping ${client.ws.ping}ms`
        : 'Chưa sẵn sàng'
    )
  );

  const generator =
    await getGenerator(
      interaction.guild.id
    ).catch(
      () => null
    );

  lines.push(
    doctorLine(
      Boolean(
        generator
      ),
      'Cấu hình server',
      generator
        ? generator.display_name
        : 'Chưa cài đặt'
    )
  );

  if (generator) {
    const buttonCategory =
      await getGuildChannel(
        interaction.guild,
        String(
          generator.button_category_id ||
          ''
        )
      );

    const blogCategory =
      await getGuildChannel(
        interaction.guild,
        String(
          generator.blog_category_id ||
          ''
        )
      );

    const createVoice =
      await getGuildChannel(
        interaction.guild,
        String(
          generator.create_voice_id ||
          ''
        )
      );

    const chatLog =
      await getGuildChannel(
        interaction.guild,
        String(
          generator.chat_log_channel_id ||
          ''
        )
      );

    const actionLog =
      await getGuildChannel(
        interaction.guild,
        String(
          generator.action_log_channel_id ||
          ''
        )
      );

    lines.push(
      doctorLine(
        buttonCategory?.type ===
          ChannelType.GuildCategory,
        'Danh mục đặt nút'
      )
    );

    lines.push(
      doctorLine(
        blogCategory?.type ===
          ChannelType.GuildCategory,
        'Danh mục Blog'
      )
    );

    lines.push(
      doctorLine(
        createVoice?.type ===
          ChannelType.GuildVoice,
        CREATE_VOICE_NAME
      )
    );

    lines.push(
      doctorLine(
        chatLog?.type ===
          ChannelType.GuildText,
        CHAT_LOG_CHANNEL_NAME
      )
    );

    lines.push(
      doctorLine(
        actionLog?.type ===
          ChannelType.GuildText,
        ACTION_LOG_CHANNEL_NAME
      )
    );

    if (
      buttonCategory &&
      blogCategory
    ) {
      const permissionCheck =
        await validateSetupPermissions(
          interaction.guild,
          buttonCategory,
          blogCategory
        );

      lines.push(
        doctorLine(
          permissionCheck.ok,
          'Quyền Bot',
          permissionCheck.ok
            ? 'Đủ quyền cần thiết'
            : permissionCheck.missing.join(
                ', '
              )
        )
      );
    }
  }

  try {
    const regions =
      await getVoiceRegions(
        true
      );

    lines.push(
      doctorLine(
        regions.length >
        0,
        'Voice Regions',
        `${regions.length} khu vực`
      )
    );
  } catch {
    lines.push(
      doctorLine(
        false,
        'Voice Regions',
        'Không tải được'
      )
    );
  }

  try {
    const absenceCount =
      await pool.query(
        `
          SELECT COUNT(*)::INT AS count
          FROM owner_absences
          WHERE guild_id = $1
        `,
        [
          interaction.guild.id
        ]
      );

    lines.push(
      doctorLine(
        true,
        'Bảo lưu chủ phòng',
        `${absenceCount.rows[0]?.count || 0} đang chờ`
      )
    );
  } catch {
    lines.push(
      doctorLine(
        false,
        'Bảo lưu chủ phòng'
      )
    );
  }

  const embed =
    new EmbedBuilder()
      .setTitle(
        '🩺 Voice HDK Doctor'
      )
      .setDescription(
        lines.join('\n')
      )
      .setFooter({
        text:
          BOT_NAME
      });

  await interaction.editReply({
    embeds: [
      embed
    ],
    components: []
  });
}

async function reconcileGeneratorVoice(
  guild,
  generator
) {
  let createVoice =
    await getGuildChannel(
      guild,
      String(
        generator.create_voice_id ||
        ''
      )
    );

  if (
    !createVoice ||
    createVoice.type !==
      ChannelType.GuildVoice
  ) {
    await pool.query(
      `
        UPDATE generators
        SET
          create_voice_id = NULL,
          updated_at = NOW()
        WHERE guild_id = $1
      `,
      [guild.id]
    );

    return null;
  }

  const category =
    await getGuildChannel(
      guild,
      String(
        generator.button_category_id ||
        ''
      )
    );

  if (
    createVoice.name !==
    CREATE_VOICE_NAME
  ) {
    await createVoice.setName(
      CREATE_VOICE_NAME,
      `${BOT_NAME}: khôi phục tên kênh tạo phòng`
    ).catch(
      error => {
        logError(
          `RECONCILE_GENERATOR_NAME:${guild.id}`,
          error
        );
      }
    );
  }

  if (
    category &&
    category.type ===
      ChannelType.GuildCategory &&
    createVoice.parentId !==
      category.id
  ) {
    await createVoice.setParent(
      category.id,
      {
        lockPermissions: false,
        reason:
          `${BOT_NAME}: khôi phục danh mục tạo phòng`
      }
    ).catch(
      error => {
        logError(
          `RECONCILE_GENERATOR_PARENT:${guild.id}`,
          error
        );
      }
    );
  }

  return createVoice;
}

async function reconcileRoom(
  guild,
  room
) {
  const channel =
    await getGuildChannel(
      guild,
      String(
        room.channel_id
      )
    );

  if (
    !channel ||
    channel.type !==
      ChannelType.GuildVoice
  ) {
    clearRuntimeOwnerAbsenceTimer(
      room.channel_id
    );

    clearEmptyRoomTimer(
      room.channel_id
    );

    clearPendingTransfer(
      room.channel_id
    );

    clearSelectionsForChannel(
      guild.id,
      room.channel_id
    );

    await deleteOwnershipTracking(
      room.channel_id
    );

    await deleteRoomRecord(
      room.channel_id
    );

    return;
  }

  try {
    await ensureBotRoomPermissions(
      channel
    );

    const owner =
      await getGuildMember(
        guild,
        String(
          room.owner_id
        )
      );

    if (owner) {
      await grantOwnerPermissions(
        channel,
        owner
      );
    }

    await syncCurrentRoomPresence(
      channel
    );

    const humans =
      humanMembers(
        channel
      );

    if (
      humans.length ===
      0
    ) {
      const absence =
        await getOwnerAbsence(
          channel.id
        );

      if (absence) {
        await deleteOwnerAbsenceNotice(
          channel,
          absence
        );

        await deleteOwnerAbsence(
          channel.id
        );
      }

      scheduleEmptyRoomCheck(
        channel.id
      );

      return;
    }

    clearEmptyRoomTimer(
      channel.id
    );

    const ownerPresent =
      owner &&
      owner.voice?.channelId ===
        channel.id;

    const absence =
      await getOwnerAbsence(
        channel.id
      );

    if (ownerPresent) {
      if (absence) {
        await cancelOwnerAbsence(
          channel
        );
      }
    } else if (absence) {
      if (
        String(
          absence.owner_id
        ) !==
        String(
          room.owner_id
        )
      ) {
        await deleteOwnerAbsenceNotice(
          channel,
          absence
        );

        await deleteOwnerAbsence(
          channel.id
        );

        if (owner) {
          await beginOwnerAbsence(
            channel,
            room,
            owner
          );
        }
      } else {
        await scheduleOwnerAbsenceTimer(
          channel.id,
          absence.deadline_at
        );
      }
    } else if (owner) {
      await beginOwnerAbsence(
        channel,
        room,
        owner
      );
    } else {
      const syntheticOwner = {
        displayName:
          'Chủ phòng'
      };

      await beginOwnerAbsence(
        channel,
        room,
        syntheticOwner
      );
    }

    await refreshRoomPanelSafe(
      channel.id
    );
  } catch (error) {
    logError(
      `RECONCILE_ROOM:${room.channel_id}`,
      error
    );
  }
}

async function reconcileGuildRooms(
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
    await reconcileRoom(
      guild,
      room
    );
  }
}

async function reconcileGuild(
  guild
) {
  const generator =
    await getGenerator(
      guild.id
    );

  if (!generator) {
    return;
  }

  await reconcileGeneratorVoice(
    guild,
    generator
  );

  await reconcileGuildRooms(
    guild
  );
}

async function reconcileAllGuilds() {
  for (
    const guild
    of client.guilds.cache.values()
  ) {
    try {
      await reconcileGuild(
        guild
      );
    } catch (error) {
      logError(
        `RECONCILE_GUILD:${guild.id}`,
        error
      );
    }
  }
}
async function handleSystemResetCommand(
  interaction
) {
  await safeDeferReply(
    interaction,
    true
  );

  if (
    !interaction.guild ||
    !canManageSetup(interaction)
  ) {
    await tempReply(
      interaction,
      '❌ Bạn cần quyền Quản lý máy chủ để dùng /reset.',
      { error: true }
    );
    return;
  }

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('system_reset_confirm')
          .setLabel('Xác nhận reset')
          .setEmoji('🗑️')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('system_reset_cancel')
          .setLabel('Hủy')
          .setStyle(ButtonStyle.Secondary)
      );

  await interaction.editReply({
    content: [
      '⚠️ **RESET VOICE HDK**',
      'Thao tác này xóa các phòng, generator, kênh log và dữ liệu Voice HDK của server này.',
      'Category Discord và các kênh không thuộc Voice HDK sẽ được giữ nguyên.'
    ].join('\n'),
    components: [row]
  });
}

async function handleSystemResetConfirm(
  interaction
) {
  await safeDeferUpdate(interaction);

  if (
    !interaction.guild ||
    !canManageSetup(interaction)
  ) {
    await interaction.editReply({
      content: '❌ Bạn không có quyền reset Voice HDK.',
      components: [],
      embeds: []
    });
    deleteReplyLater(interaction, ERROR_DELETE_MS);
    return;
  }

  try {
    await cleanupGuildInstallation(
      interaction.guild
    );

    for (const [key, value] of setupSessions.entries()) {
      if (key.startsWith(`${interaction.guild.id}:`)) {
        if (value?.timer) clearTimeout(value.timer);
        setupSessions.delete(key);
      }
    }

    for (const [key, value] of selectedMembers.entries()) {
      if (key.startsWith(`${interaction.guild.id}:`)) {
        if (value?.timer) clearTimeout(value.timer);
        selectedMembers.delete(key);
      }
    }

    await interaction.editReply({
      content: '✅ Đã reset sạch Voice HDK của server này. Dùng `/setup` để cài lại.',
      components: [],
      embeds: []
    });
    deleteReplyLater(interaction, SUCCESS_DELETE_MS);
  } catch (error) {
    logError('SYSTEM_RESET', error);
    await interaction.editReply({
      content: '❌ Reset chưa hoàn tất. Bot đã giữ dữ liệu còn lại để tránh mất dấu tài nguyên.',
      components: [],
      embeds: []
    });
    deleteReplyLater(interaction, ERROR_DELETE_MS);
  }
}

async function handleSystemResetCancel(
  interaction
) {
  await safeDeferUpdate(interaction);
  await interaction.editReply({
    content: '✖️ Đã hủy reset Voice HDK.',
    components: [],
    embeds: []
  });
  deleteReplyLater(interaction, SUCCESS_DELETE_MS);
}

async function routeButtonInteraction(
  interaction
) {
  switch (
    interaction.customId
  ) {
    case 'setup_name':
      await handleSetupNameButton(
        interaction
      );
      return;

    case 'setup_install':
      await handleSetupInstall(
        interaction
      );
      return;

    case 'setup_reinstall_confirm':
      await handleReinstallConfirm(
        interaction
      );
      return;

    case 'setup_uninstall':
      await handleSetupUninstall(
        interaction
      );
      return;

    case 'setup_reinstall_cancel':
      await handleReinstallCancel(
        interaction
      );
      return;

    case 'room_lock':
      await handleRoomLock(
        interaction
      );
      return;

    case 'room_hide':
      await handleRoomHide(
        interaction
      );
      return;

    case 'room_rename':
      await handleRoomRenameButton(
        interaction
      );
      return;

    case 'room_reset':
      await handleRoomResetButton(
        interaction
      );
      return;

    case 'room_reset_confirm':
      await handleRoomResetConfirm(
        interaction
      );
      return;

    case 'room_reset_cancel':
      await handleRoomResetCancel(
        interaction
      );
      return;

    case 'room_limit':
      await handleRoomLimitButton(
        interaction
      );
      return;

    case 'room_invite':
      await handleRoomInvite(
        interaction
      );
      return;

    case 'room_deny':
      await handleRoomDeny(
        interaction
      );
      return;

    case 'room_kick':
      await handleRoomKick(
        interaction
      );
      return;

    case 'room_transfer':
      await handleRoomTransferButton(
        interaction
      );
      return;

    case 'transfer_accept':
      await handleTransferAccept(
        interaction
      );
      return;

    case 'transfer_decline':
      await handleTransferDecline(
        interaction
      );
      return;

    case 'system_reset_confirm':
      await handleSystemResetConfirm(
        interaction
      );
      return;

    case 'system_reset_cancel':
      await handleSystemResetCancel(
        interaction
      );
      return;

    default:
      return;
  }
}

async function routeSelectInteraction(
  interaction
) {
  if (
    interaction.isChannelSelectMenu()
  ) {
    if (
      interaction.customId ===
      'setup_button_category'
    ) {
      await handleSetupCategorySelect(
        interaction,
        'button'
      );

      return;
    }

    if (
      interaction.customId ===
      'setup_blog_category'
    ) {
      await handleSetupCategorySelect(
        interaction,
        'blog'
      );

      return;
    }
  }

  if (
    interaction.isUserSelectMenu() &&
    (
      interaction.customId === 'room_member' ||
      interaction.customId.startsWith(
        'room_member:'
      )
    )
  ) {
    await handleRoomMemberSelect(
      interaction
    );

    return;
  }

  if (
    interaction.isStringSelectMenu() &&
    interaction.customId ===
      'room_region'
  ) {
    await handleRoomRegionSelect(
      interaction
    );
  }
}

async function routeModalInteraction(
  interaction
) {
  switch (
    interaction.customId
  ) {
    case 'setup_name_modal':
      await handleSetupNameModal(
        interaction
      );
      return;

    case 'room_rename_modal':
      await handleRoomRenameModal(
        interaction
      );
      return;

    case 'room_limit_modal':
      await handleRoomLimitModal(
        interaction
      );
      return;

    default:
      return;
  }
}
async function routeChatCommand(
  interaction
) {
  switch (
    interaction.commandName
  ) {
    case 'setup':
      await handleSetupCommand(
        interaction
      );
      return;

    case 'fixmenu':
      await handlePanelCommand(
        interaction
      );
      return;

    case 'claim':
      await handleClaimCommand(
        interaction
      );
      return;

    case 'doctor':
      await handleDoctorCommand(
        interaction
      );
      return;

    case 'reset':
      await handleSystemResetCommand(
        interaction
      );
      return;

    default:
      return;
  }
}

client.on(
  Events.InteractionCreate,
  async interaction => {
    try {
      if (
        interaction.isChatInputCommand()
      ) {
        await routeChatCommand(
          interaction
        );

        return;
      }

      if (
        interaction.isButton()
      ) {
        await routeButtonInteraction(
          interaction
        );

        return;
      }

      if (
        interaction.isAnySelectMenu()
      ) {
        await routeSelectInteraction(
          interaction
        );

        return;
      }

      if (
        interaction.isModalSubmit()
      ) {
        await routeModalInteraction(
          interaction
        );
      }
    } catch (error) {
      logError(
        `INTERACTION:${interaction.customId || interaction.commandName || 'UNKNOWN'}`,
        error
      );

      try {
        if (
          interaction.deferred ||
          interaction.replied
        ) {
          await tempFollowUp(
            interaction,
            '❌ Đã xảy ra lỗi khi xử lý thao tác.',
            {
              error: true
            }
          );
        } else {
          await interaction.reply({
            content:
              '❌ Đã xảy ra lỗi khi xử lý thao tác.',
            flags: MessageFlags.Ephemeral
          });

          deleteReplyLater(
            interaction,
            ERROR_DELETE_MS
          );
        }
      } catch {
      }
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
      if (
        oldState.channelId ===
        newState.channelId
      ) {
        return;
      }

      const member =
        newState.member ||
        oldState.member;

      if (
        !member ||
        member.user?.bot
      ) {
        return;
      }

      if (
        newState.channelId
      ) {
        await handleJoinCreateVoice(
          newState
        );
      }

      await handleOwnerVoiceTransition(
        oldState,
        newState
      );

      if (
        oldState.channelId
      ) {
        await refreshRoomAfterVoiceChange(
          oldState.channelId
        );
      }

      if (
        newState.channelId
      ) {
        await refreshRoomAfterVoiceChange(
          newState.channelId
        );
      }
    } catch (error) {
      logError(
        `VOICE_STATE:${oldState.guild?.id || newState.guild?.id || 'UNKNOWN'}`,
        error
      );
    }
  }
);

client.on(
  Events.MessageCreate,
  async message => {
    try {
      await sendChatCreateLog(
        message
      );
    } catch (error) {
      logError(
        `MESSAGE_CREATE_LOG:${message.id}`,
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
      await sendChatEditLog(
        oldMessage,
        newMessage
      );
    } catch (error) {
      logError(
        `MESSAGE_UPDATE_LOG:${newMessage?.id || oldMessage?.id || 'UNKNOWN'}`,
        error
      );
    }
  }
);

client.on(
  Events.MessageDelete,
  async message => {
    try {
      await sendChatDeleteLog(
        message
      );
    } catch (error) {
      logError(
        `MESSAGE_DELETE_LOG:${message?.id || 'UNKNOWN'}`,
        error
      );
    }
  }
);

client.on(
  Events.MessageBulkDelete,
  async (
    messages,
    channel
  ) => {
    try {
      await sendBulkDeleteLog(
        messages,
        channel
      );
    } catch (error) {
      logError(
        `MESSAGE_BULK_DELETE_LOG:${channel?.id || 'UNKNOWN'}`,
        error
      );
    }
  }
);

client.on(
  Events.ChannelDelete,
  async channel => {
    try {
      if (
        !channel.guild
      ) {
        return;
      }

      const room =
        await getRoom(
          channel.id
        );

      if (room) {
        clearEmptyRoomTimer(
          channel.id
        );

        clearRuntimeOwnerAbsenceTimer(
          channel.id
        );

        clearPendingTransfer(
          channel.id
        );

        clearSelectionsForChannel(
          channel.guild.id,
          channel.id
        );

        await deleteOwnershipTracking(
          channel.id
        );

        await deleteRoomRecord(
          channel.id
        );

        return;
      }

      const generator =
        await getGenerator(
          channel.guild.id
        );

      if (!generator) {
        return;
      }

      if (
        String(
          generator.create_voice_id ||
          ''
        ) ===
        channel.id
      ) {
        await pool.query(
          `
            UPDATE generators
            SET
              create_voice_id = NULL,
              updated_at = NOW()
            WHERE guild_id = $1
          `,
          [
            channel.guild.id
          ]
        );

        return;
      }

      if (
        String(
          generator.chat_log_channel_id ||
          ''
        ) ===
        channel.id
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
            channel.guild.id
          ]
        );

        return;
      }

      if (
        String(
          generator.action_log_channel_id ||
          ''
        ) ===
        channel.id
      ) {
        await pool.query(
          `
            UPDATE generators
            SET
              action_log_channel_id = NULL,
              updated_at = NOW()
            WHERE guild_id = $1
          `,
          [
            channel.guild.id
          ]
        );
      }
    } catch (error) {
      logError(
        `CHANNEL_DELETE:${channel?.id || 'UNKNOWN'}`,
        error
      );
    }
  }
);

client.on(
  Events.GuildDelete,
  async guild => {
    try {
      for (
        const [
          key,
          value
        ]
        of setupSessions.entries()
      ) {
        if (
          key.startsWith(
            `${guild.id}:`
          )
        ) {
          setupSessions.delete(
            key
          );
        }
      }

      for (
        const [
          key,
          value
        ]
        of selectedMembers.entries()
      ) {
        if (
          key.startsWith(
            `${guild.id}:`
          )
        ) {
          if (
            value?.timer
          ) {
            clearTimeout(
              value.timer
            );
          }

          selectedMembers.delete(
            key
          );
        }
      }

      const rooms =
        await getGuildRooms(
          guild.id
        ).catch(
          () => []
        );

      for (
        const room
        of rooms
      ) {
        clearEmptyRoomTimer(
          room.channel_id
        );

        clearRuntimeOwnerAbsenceTimer(
          room.channel_id
        );

        clearPendingTransfer(
          room.channel_id
        );
      }
    } catch (error) {
      logError(
        `GUILD_DELETE:${guild.id}`,
        error
      );
    }
  }
);

client.once(
  Events.ClientReady,
  async readyClient => {
    try {
      console.log(
        `[READY] ${readyClient.user.tag} | ${readyClient.guilds.cache.size} server(s)`
      );

      await registerSlashCommands();

      await reconcileAllGuilds();

      console.log(
        `[READY] ${BOT_NAME} đã sẵn sàng.`
      );
    } catch (error) {
      logError(
        'CLIENT_READY',
        error
      );
    }
  }
);

async function gracefulShutdown(
  signal
) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(
    `[SHUTDOWN] ${signal}`
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
    const pending
    of pendingTransfers.values()
  ) {
    if (
      pending?.timer
    ) {
      clearTimeout(
        pending.timer
      );
    }
  }

  pendingTransfers.clear();

  try {
    client.destroy();
  } catch {
  }

  try {
    if (
      healthServer.listening
    ) {
      await new Promise(
        resolve => {
          healthServer.close(
            resolve
          );
        }
      );
    }
  } catch {
  }

  try {
    await pool.end();
  } catch {
  }

  process.exit(
    0
  );
}

process.once(
  'SIGTERM',
  () => {
    gracefulShutdown(
      'SIGTERM'
    ).catch(
      error => {
        logError(
          'SHUTDOWN_SIGTERM',
          error
        );

        process.exit(
          1
        );
      }
    );
  }
);

process.once(
  'SIGINT',
  () => {
    gracefulShutdown(
      'SIGINT'
    ).catch(
      error => {
        logError(
          'SHUTDOWN_SIGINT',
          error
        );

        process.exit(
          1
        );
      }
    );
  }
);

async function startBot() {
  console.log(
    `[START] ${BOT_NAME}`
  );

  await initDatabase();

  await ensureOwnershipTrackingTables();

  await new Promise(
    (
      resolve,
      reject
    ) => {
      healthServer.once(
        'error',
        reject
      );

      healthServer.listen(
        PORT,
        '0.0.0.0',
        () => {
          healthServer.removeListener(
            'error',
            reject
          );

          console.log(
            `[HTTP] Health server đang chạy tại 0.0.0.0:${PORT}`
          );

          resolve();
        }
      );
    }
  );

  await client.login(
    TOKEN
  );
}

startBot().catch(
  error => {
    logError(
      'STARTUP_FATAL',
      error
    );

    try {
      client.destroy();
    } catch {
    }

    if (
      healthServer.listening
    ) {
      try {
        healthServer.close();
      } catch {
      }
    }

    pool.end()
      .catch(
        () => {}
      )
      .finally(
        () => {
          process.exit(
            1
          );
        }
      );
  }
);

// UPTIMEROBOT / RENDER FREE
// URL: https://TEN-SERVICE-CUA-BAN.onrender.com/health
// Method: GET
