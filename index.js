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
  OverwriteType
} = require('discord.js');

const { Pool } = require('pg');
const http = require('http');

const BOT_NAME = 'Voice HDK';
const BOT_VERSION = '7.0.0';

const TOKEN =
  process.env.DISCORD_TOKEN ||
  process.env.TOKEN;

const DATABASE_URL =
  process.env.DATABASE_URL;

const PORT =
  Number(
    process.env.PORT ||
    3000
  );

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

const NOTICE_DELETE_MS =
  4000;

const SUCCESS_DELETE_MS =
  NOTICE_DELETE_MS;

const ERROR_DELETE_MS =
  NOTICE_DELETE_MS;

const ACTION_COOLDOWN_MS =
  1500;

const TRANSFER_TIMEOUT_MS =
  60 * 1000;

const OWNER_ABSENCE_GRACE_MS =
  10 * 60 * 1000;

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
    'Thiếu DISCORD_TOKEN hoặc TOKEN.'
  );
}

if (!DATABASE_URL) {
  throw new Error(
    'Thiếu DATABASE_URL.'
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

const roomLifecycleLocks =
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

const ownerAbsenceTimers =
  new Map();

let regionCache = {
  expiresAt: 0,
  regions: []
};

let shuttingDown =
  false;

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

function logError(
  scope,
  error
) {
  const message =
    error?.stack ||
    error?.message ||
    String(error);

  console.error(
    `[${scope}]`,
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
      '[DISCORD_WARN]',
      warning
    );
  }
);

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

    setTimeout(
      () => {
        process.exit(1);
      },
      250
    ).unref?.();
  }
);

const healthServer =
  http.createServer(
    (
      request,
      response
    ) => {
      if (
        request.url === '/' ||
        request.url === '/health'
      ) {
        response.writeHead(
          200,
          {
            'Content-Type':
              'application/json; charset=utf-8',
            'Cache-Control':
              'no-store'
          }
        );

        response.end(
          JSON.stringify({
            ok: true,
            service:
              BOT_NAME,
            version:
              BOT_VERSION
          })
        );

        return;
      }

      response.writeHead(
        404,
        {
          'Content-Type':
            'application/json; charset=utf-8'
        }
      );

      response.end(
        JSON.stringify({
          ok: false,
          error:
            'Not Found'
        })
      );
    }
  );

async function columnExists(
  tableName,
  columnName
) {
  const result =
    await pool.query(
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
  columnName
) {
  if (
    !/^[a-z_]+$/i.test(
      tableName
    ) ||
    !/^[a-z_]+$/i.test(
      columnName
    )
  ) {
    throw new Error(
      'INVALID_SCHEMA_IDENTIFIER'
    );
  }

  const exists =
    await columnExists(
      tableName,
      columnName
    );

  if (!exists) {
    return;
  }

  await pool.query(
    `
      ALTER TABLE ${tableName}
      ALTER COLUMN ${columnName}
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

    await dbClient.query(`
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
    `);

    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        guild_id BIGINT NOT NULL,
        channel_id BIGINT PRIMARY KEY,
        owner_id BIGINT NOT NULL,
        category_id BIGINT,
        control_message_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await dbClient.query(`
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
    `);

    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS owner_absences (
        channel_id BIGINT PRIMARY KEY,
        guild_id BIGINT NOT NULL,
        owner_id BIGINT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deadline_at TIMESTAMPTZ NOT NULL,
        notice_message_id BIGINT
      )
    `);

    await dbClient.query(`
      DELETE FROM rooms a
      USING rooms b
      WHERE
        a.ctid < b.ctid
        AND a.guild_id = b.guild_id
        AND a.owner_id = b.owner_id
    `);

    await dbClient.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      idx_rooms_one_owner_per_guild
      ON rooms (
        guild_id,
        owner_id
      )
    `);

    await dbClient.query(`
      CREATE INDEX IF NOT EXISTS
      idx_rooms_guild
      ON rooms (
        guild_id
      )
    `);

    await dbClient.query(`
      CREATE INDEX IF NOT EXISTS
      idx_room_presence_channel_joined
      ON room_presence (
        channel_id,
        joined_at ASC
      )
    `);

    await dbClient.query(`
      CREATE INDEX IF NOT EXISTS
      idx_owner_absences_deadline
      ON owner_absences (
        deadline_at
      )
    `);

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

  const legacyColumns = [
    'category_id',
    'generator_id',
    'channel_id',
    'voice_channel_id',
    'control_channel_id'
  ];

  for (
    const columnName
    of legacyColumns
  ) {
    await dropNotNullIfColumnExists(
      'generators',
      columnName
    );
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
        guildId,
        displayName,
        buttonCategoryId,
        blogCategoryId,
        createVoiceId,
        chatLogChannelId,
        actionLogChannelId
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

async function setTrackedTextChannel(
  guildId,
  channelId
) {
  await pool.query(
    `
      UPDATE generators
      SET
        tracked_text_channel_id = $2,
        updated_at = NOW()
      WHERE guild_id = $1
    `,
    [
      guildId,
      channelId
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
        guildId,
        ownerId
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

async function saveRoom({
  guildId,
  channelId,
  ownerId,
  categoryId,
  controlMessageId = null,
  dbClient = pool
}) {
  const result =
    await dbClient.query(
      `
        INSERT INTO rooms (
          guild_id,
          channel_id,
          owner_id,
          category_id,
          control_message_id
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5
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
            COALESCE(
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
      SET control_message_id = $2
      WHERE channel_id = $1
    `,
    [
      channelId,
      messageId
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
        SET owner_id = $2
        WHERE channel_id = $1
        RETURNING *
      `,
      [
        channelId,
        ownerId
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
  const rooms =
    await dbClient.query(
      `
        SELECT channel_id
        FROM rooms
        WHERE guild_id = $1
      `,
      [
        guildId
      ]
    );

  for (
    const row
    of rooms.rows
  ) {
    await dbClient.query(
      `
        DELETE FROM room_presence
        WHERE channel_id = $1
      `,
      [
        row.channel_id
      ]
    );

    await dbClient.query(
      `
        DELETE FROM owner_absences
        WHERE channel_id = $1
      `,
      [
        row.channel_id
      ]
    );
  }

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
  const result =
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
        RETURNING *
      `,
      [
        guildId,
        channelId,
        memberId,
        joinedAt
      ]
    );

  return (
    result.rows[0] ||
    null
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
            EXCLUDED.notice_message_id
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

  return (
    result.rows[0] ||
    null
  );
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

function isSnowflake(
  value
) {
  return (
    typeof value ===
      'string' &&
    /^\d{16,22}$/.test(
      value
    )
  );
}

function cleanDisplayName(
  value
) {
  return String(
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
    .trim()
    .slice(
      0,
      50
    );
}

function cleanRoomName(
  value
) {
  return String(
    value || ''
  )
    .replace(
      ROOM_PREFIX,
      ''
    )
    .replace(
      /^➕\s*/,
      ''
    )
    .replace(
      /[\r\n]/g,
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

function safeMemberName(
  member
) {
  return cleanDisplayName(
    member?.displayName ||
    member?.user?.globalName ||
    member?.user?.username ||
    'Không xác định'
  );
}

function vietnamTime(
  date =
    new Date()
) {
  const parts =
    new Intl.DateTimeFormat(
      'en-GB',
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

  const map =
    Object.fromEntries(
      parts.map(
        part => [
          part.type,
          part.value
        ]
      )
    );

  return (
    `${map.hour}:${map.minute}:${map.second} ` +
    `${map.day}/${map.month}/${map.year}`
  );
}

function relativeTimestamp(
  value
) {
  const time =
    value instanceof Date
      ? value.getTime()
      : Number(value);

  return (
    `<t:${Math.floor(
      time /
      1000
    )}:R>`
  );
}

function actionDeleteTimestamp() {
  return relativeTimestamp(
    Date.now() +
    NOTICE_DELETE_MS
  );
}

function permissionNames(
  permissions
) {
  return Object.entries(
    REQUIRED_BOT_PERMISSIONS
  )
    .filter(
      (
        [
          name,
          flag
        ]
      ) =>
        !permissions.has(
          flag
        )
    )
    .map(
      (
        [
          name
        ]
      ) =>
        name
    );
}

function sleep(
  milliseconds
) {
  return new Promise(
    resolve => {
      setTimeout(
        resolve,
        milliseconds
      );
    }
  );
}
function errorCode(error) {
  return (
    error?.code ??
    error?.rawError?.code ??
    null
  );
}

function isUnknownDiscordResource(error) {
  const code =
    errorCode(error);

  return (
    code === 10003 ||
    code === 10008 ||
    code === 10015 ||
    code === 10062
  );
}

async function safeDeleteMessage(
  message
) {
  if (!message) {
    return false;
  }

  try {
    if (
      typeof message.delete ===
      'function'
    ) {
      await message.delete();
      return true;
    }
  } catch (error) {
    if (
      !isUnknownDiscordResource(
        error
      )
    ) {
      logError(
        'SAFE_DELETE_MESSAGE',
        error
      );
    }
  }

  return false;
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
      () => {
        safeDeleteMessage(
          message
        ).catch(
          error => {
            logError(
              'SCHEDULE_MESSAGE_DELETE',
              error
            );
          }
        );
      },
      delay
    );

  timer.unref?.();
}

async function fetchChannelSafe(
  guild,
  channelId
) {
  if (
    !guild ||
    !isSnowflake(
      String(
        channelId ||
        ''
      )
    )
  ) {
    return null;
  }

  const cached =
    guild.channels.cache.get(
      String(channelId)
    );

  if (cached) {
    return cached;
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
        'FETCH_CHANNEL_SAFE',
        error
      );
    }

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
        memberId ||
        ''
      )
    )
  ) {
    return null;
  }

  const cached =
    guild.members.cache.get(
      String(memberId)
    );

  if (cached) {
    return cached;
  }

  try {
    return await guild.members.fetch(
      String(memberId)
    );
  } catch (error) {
    if (
      !isUnknownDiscordResource(
        error
      )
    ) {
      logError(
        'FETCH_MEMBER_SAFE',
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
      String(
        messageId ||
        ''
      )
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
        'FETCH_MESSAGE_SAFE',
        error
      );
    }

    return null;
  }
}

function isVoiceChannel(
  channel
) {
  return (
    channel?.type ===
      ChannelType.GuildVoice
  );
}

function isCategoryChannel(
  channel
) {
  return (
    channel?.type ===
      ChannelType.GuildCategory
  );
}

function isGuildTextChannel(
  channel
) {
  return (
    channel?.type ===
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

function channelHumanMembers(
  channel
) {
  if (
    !isVoiceChannel(
      channel
    )
  ) {
    return [];
  }

  return [
    ...channel.members.values()
  ].filter(
    isHumanMember
  );
}

async function getBotMember(
  guild
) {
  if (!guild) {
    return null;
  }

  if (
    guild.members.me
  ) {
    return guild.members.me;
  }

  try {
    return await guild.members.fetchMe();
  } catch (error) {
    logError(
      'FETCH_BOT_MEMBER',
      error
    );

    return null;
  }
}

function botPermissionsIn(
  channel,
  botMember
) {
  if (
    !channel ||
    !botMember
  ) {
    return null;
  }

  try {
    return channel.permissionsFor(
      botMember
    );
  } catch (error) {
    logError(
      'BOT_PERMISSIONS_IN',
      error
    );

    return null;
  }
}

async function validateBotChannelPermissions(
  channel,
  requiredFlags
) {
  if (!channel?.guild) {
    return {
      ok: false,
      missing: [
        'ViewChannel'
      ]
    };
  }

  const botMember =
    await getBotMember(
      channel.guild
    );

  if (!botMember) {
    return {
      ok: false,
      missing: [
        'BotMember'
      ]
    };
  }

  const permissions =
    botPermissionsIn(
      channel,
      botMember
    );

  if (!permissions) {
    return {
      ok: false,
      missing: [
        'Permissions'
      ]
    };
  }

  const missing = [];

  for (
    const [
      name,
      flag
    ]
    of Object.entries(
      requiredFlags
    )
  ) {
    if (
      !permissions.has(
        flag
      )
    ) {
      missing.push(
        name
      );
    }
  }

  return {
    ok:
      missing.length === 0,
    missing
  };
}

async function validateGuildBotPermissions(
  guild
) {
  const botMember =
    await getBotMember(
      guild
    );

  if (!botMember) {
    return {
      ok: false,
      missing: [
        'BotMember'
      ]
    };
  }

  const permissions =
    botMember.permissions;

  if (!permissions) {
    return {
      ok: false,
      missing: [
        'Permissions'
      ]
    };
  }

  const missing =
    permissionNames(
      permissions
    );

  return {
    ok:
      missing.length === 0,
    missing
  };
}

function validOverwriteTargetId(
  guild,
  targetId
) {
  const id =
    String(
      targetId ||
      ''
    );

  if (
    !guild ||
    !isSnowflake(
      id
    )
  ) {
    return false;
  }

  if (
    id ===
    guild.id
  ) {
    return true;
  }

  if (
    guild.roles.cache.has(
      id
    )
  ) {
    return true;
  }

  if (
    guild.members.cache.has(
      id
    )
  ) {
    return true;
  }

  return false;
}

async function resolveOverwriteTarget(
  guild,
  targetId
) {
  const id =
    String(
      targetId ||
      ''
    );

  if (
    !guild ||
    !isSnowflake(
      id
    )
  ) {
    return null;
  }

  if (
    id ===
    guild.id
  ) {
    return guild.roles.everyone;
  }

  const role =
    guild.roles.cache.get(
      id
    );

  if (role) {
    return role;
  }

  const member =
    await fetchMemberSafe(
      guild,
      id
    );

  return (
    member ||
    null
  );
}

async function safePermissionEdit(
  channel,
  targetId,
  permissions,
  reason
) {
  if (
    !channel?.guild ||
    !channel.permissionOverwrites
  ) {
    return false;
  }

  const target =
    await resolveOverwriteTarget(
      channel.guild,
      targetId
    );

  if (!target) {
    logError(
      'SAFE_PERMISSION_EDIT',
      new Error(
        `Không tìm thấy overwrite target: ${targetId}`
      )
    );

    return false;
  }

  try {
    await channel.permissionOverwrites.edit(
      target,
      permissions,
      {
        reason:
          reason ||
          `${BOT_NAME} cập nhật quyền phòng`
      }
    );

    return true;
  } catch (error) {
    logError(
      'SAFE_PERMISSION_EDIT',
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
    !channel?.guild ||
    !channel.permissionOverwrites
  ) {
    return false;
  }

  const id =
    String(
      targetId ||
      ''
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
      reason ||
      `${BOT_NAME} xóa quyền riêng`
    );

    return true;
  } catch (error) {
    if (
      !isUnknownDiscordResource(
        error
      )
    ) {
      logError(
        'SAFE_PERMISSION_DELETE',
        error
      );
    }

    return false;
  }
}

async function grantRoomOwnerPermissions(
  channel,
  member
) {
  if (
    !channel ||
    !member ||
    member.guild?.id !==
      channel.guild?.id
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
        true,
      Stream:
        true,
      UseVAD:
        true
    },
    `${BOT_NAME} cấp quyền chủ phòng`
  );
}

async function revokeOldOwnerPermissions(
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
  member
) {
  if (
    !channel ||
    !member ||
    member.guild?.id !==
      channel.guild?.id
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
  member
) {
  if (
    !channel ||
    !member ||
    member.guild?.id !==
      channel.guild?.id
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

async function clearMemberSpecificOverwrites(
  channel,
  preserveMemberIds = []
) {
  if (
    !channel?.guild ||
    !channel.permissionOverwrites
  ) {
    return;
  }

  const preserve =
    new Set(
      preserveMemberIds
        .filter(Boolean)
        .map(String)
    );

  const overwrites =
    [
      ...channel
        .permissionOverwrites
        .cache
        .values()
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

    await safePermissionDelete(
      channel,
      overwrite.id,
      `${BOT_NAME} đặt lại quyền thành viên`
    );
  }
}

function withKeyLock(
  map,
  key,
  task
) {
  const normalizedKey =
    String(key);

  const previous =
    map.get(
      normalizedKey
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
    normalizedKey,
    current
  );

  current
    .finally(
      () => {
        if (
          map.get(
            normalizedKey
          ) === current
        ) {
          map.delete(
            normalizedKey
          );
        }
      }
    )
    .catch(
      () => {}
    );

  return current;
}

function withPanelLock(
  channelId,
  task
) {
  return withKeyLock(
    panelLocks,
    channelId,
    task
  );
}

function withCreateLock(
  guildId,
  memberId,
  task
) {
  return withKeyLock(
    createLocks,
    `${guildId}:${memberId}`,
    task
  );
}

function withRoomLifecycleLock(
  channelId,
  task
) {
  return withKeyLock(
    roomLifecycleLocks,
    channelId,
    task
  );
}

function cooldownKey(
  interaction,
  action
) {
  return (
    `${interaction.guildId}:` +
    `${interaction.user.id}:` +
    `${action}`
  );
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
        250
    );

  timer.unref?.();

  return 0;
}

function noticePrefix(
  type
) {
  switch (type) {
    case 'success':
      return '✅';

    case 'warning':
      return '⚠️';

    case 'error':
      return '⛔';

    case 'info':
    default:
      return '🔹';
  }
}

function buildNoticeText(
  content,
  type =
    'info',
  deleteAfter =
    NOTICE_DELETE_MS
) {
  const clean =
    String(
      content ||
      ''
    )
      .trim()
      .slice(
        0,
        1500
      );

  const expiresAt =
    Date.now() +
    deleteAfter;

  return (
    `${noticePrefix(type)} ${clean}\n` +
    `⏳ Tự xóa ${relativeTimestamp(expiresAt)}`
  );
}

async function deleteInteractionOriginalLater(
  interaction,
  delay =
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
      delay
    );

  timer.unref?.();
}

async function deleteInteractionFollowUpLater(
  interaction,
  messageId,
  delay =
    NOTICE_DELETE_MS
) {
  if (
    !interaction?.webhook ||
    !messageId
  ) {
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
              'DELETE_INTERACTION_FOLLOWUP',
              error
            );
          }
        }
      },
      delay
    );

  timer.unref?.();
}

async function tempReply(
  interaction,
  content,
  type =
    'info',
  deleteAfter =
    NOTICE_DELETE_MS
) {
  const payload = {
    content:
      buildNoticeText(
        content,
        type,
        deleteAfter
      ),
    ephemeral:
      true,
    fetchReply:
      true
  };

  try {
    if (
      interaction.deferred
    ) {
      const message =
        await interaction.editReply({
          content:
            payload.content
        });

      deleteInteractionOriginalLater(
        interaction,
        deleteAfter
      );

      return message;
    }

    if (
      interaction.replied
    ) {
      const message =
        await interaction.followUp(
          payload
        );

      deleteInteractionFollowUpLater(
        interaction,
        message.id,
        deleteAfter
      );

      return message;
    }

    const message =
      await interaction.reply(
        payload
      );

    deleteInteractionOriginalLater(
      interaction,
      deleteAfter
    );

    return message;
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

    return null;
  }
}

async function tempFollowUp(
  interaction,
  content,
  type =
    'info',
  deleteAfter =
    NOTICE_DELETE_MS
) {
  try {
    const message =
      await interaction.followUp({
        content:
          buildNoticeText(
            content,
            type,
            deleteAfter
          ),
        ephemeral:
          true,
        fetchReply:
          true
      });

    deleteInteractionFollowUpLater(
      interaction,
      message.id,
      deleteAfter
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
  type =
    'info'
) {
  if (
    interaction.deferred ||
    interaction.replied
  ) {
    return tempFollowUp(
      interaction,
      content,
      type,
      NOTICE_DELETE_MS
    );
  }

  return tempReply(
    interaction,
    content,
    type,
    NOTICE_DELETE_MS
  );
}

async function sendTemporaryChannelNotice(
  channel,
  content,
  type =
    'info',
  deleteAfter =
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
            type,
            deleteAfter
          ),
        allowedMentions: {
          parse: []
        }
      });

    scheduleMessageDelete(
      message,
      deleteAfter
    );

    return message;
  } catch (error) {
    logError(
      'TEMP_CHANNEL_NOTICE',
      error
    );

    return null;
  }
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
        'ACK_COMPONENT',
        error
      );
    }

    return false;
  }
}

function selectedMemberKey(
  guildId,
  channelId,
  ownerId
) {
  return (
    `${guildId}:` +
    `${channelId}:` +
    `${ownerId}`
  );
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
      memberId:
        String(
          memberId
        ),
      expiresAt:
        Date.now() +
        SELECTED_MEMBER_TIMEOUT_MS
    }
  );

  const timer =
    setTimeout(
      () => {
        const current =
          selectedMembers.get(
            key
          );

        if (
          current &&
          current.expiresAt <=
            Date.now()
        ) {
          selectedMembers.delete(
            key
          );
        }
      },
      SELECTED_MEMBER_TIMEOUT_MS +
        500
    );

  timer.unref?.();
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

  const selected =
    selectedMembers.get(
      key
    );

  if (!selected) {
    return null;
  }

  if (
    selected.expiresAt <=
    Date.now()
  ) {
    selectedMembers.delete(
      key
    );

    return null;
  }

  return selected.memberId;
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

function setupSessionKey(
  guildId,
  userId
) {
  return (
    `${guildId}:${userId}`
  );
}

function setSetupSession(
  guildId,
  userId,
  values
) {
  const key =
    setupSessionKey(
      guildId,
      userId
    );

  const previous =
    setupSessions.get(
      key
    ) ||
    {};

  const session = {
    ...previous,
    ...values,
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
    setupSessions.delete(
      key
    );

    return null;
  }

  return session;
}

function clearSetupSession(
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
    return null;
  }

  return transfer;
}

function setPendingTransfer(
  channelId,
  transfer
) {
  pendingTransfers.set(
    transferKey(
      channelId
    ),
    transfer
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

  return transfer || null;
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

async function fetchVoiceRegionsSafe(
  force =
    false
) {
  const now =
    Date.now();

  if (
    !force &&
    regionCache.regions.length >
      0 &&
    regionCache.expiresAt >
      now
  ) {
    return regionCache.regions;
  }

  try {
    const regions =
      await client.fetchVoiceRegions();

    const normalized =
      [
        ...regions.values()
      ]
        .filter(
          region =>
            region &&
            region.id
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
              )
            )
        );

    regionCache = {
      expiresAt:
        now +
        REGION_CACHE_MS,
      regions:
        normalized
    };

    return normalized;
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

async function findVoiceRegion(
  regionId
) {
  if (
    !regionId ||
    regionId ===
      'automatic'
  ) {
    return null;
  }

  let regions =
    await fetchVoiceRegionsSafe(
      false
    );

  let found =
    regions.find(
      region =>
        region.id ===
        regionId
    );

  if (found) {
    return found;
  }

  regions =
    await fetchVoiceRegionsSafe(
      true
    );

  found =
    regions.find(
      region =>
        region.id ===
        regionId
    );

  return found || null;
}

function regionDisplayName(
  region
) {
  if (!region) {
    return 'Tự động';
  }

  return cleanDisplayName(
    region.name ||
    region.id ||
    'Tự động'
  );
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
      label:
        'Không hợp lệ'
    };
  }

  try {
    if (
      !regionId ||
      regionId ===
        'automatic'
    ) {
      await channel.setRTCRegion(
        null,
        `${BOT_NAME} đặt khu vực tự động`
      );

      const refreshed =
        await channel.guild.channels.fetch(
          channel.id,
          {
            force:
              true
          }
        ).catch(
          () =>
            null
        );

      return {
        ok:
          !refreshed?.rtcRegion,
        label:
          'Tự động'
      };
    }

    const region =
      await findVoiceRegion(
        regionId
      );

    if (!region) {
      return {
        ok: false,
        label:
          'Khu vực không tồn tại'
      };
    }

    await channel.setRTCRegion(
      region.id,
      `${BOT_NAME} đổi khu vực thoại`
    );

    const refreshed =
      await channel.guild.channels.fetch(
        channel.id,
        {
          force:
            true
        }
      ).catch(
        () =>
          null
      );

    const actualRegion =
      refreshed?.rtcRegion ||
      channel.rtcRegion;

    return {
      ok:
        actualRegion ===
        region.id,
      label:
        regionDisplayName(
          region
        )
    };
  } catch (error) {
    logError(
      'SET_VOICE_REGION',
      error
    );

    return {
      ok: false,
      label:
        'Không thể thay đổi'
    };
  }
}

async function safeMoveMember(
  member,
  channel,
  reason =
    `${BOT_NAME} di chuyển thành viên`
) {
  if (
    !member ||
    !isVoiceChannel(
      channel
    ) ||
    member.guild?.id !==
      channel.guild?.id
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
      'SAFE_MOVE_MEMBER',
      error
    );

    return false;
  }
}

async function safeDisconnectMember(
  member,
  expectedChannelId,
  reason =
    `${BOT_NAME} ngắt kết nối thành viên`
) {
  if (
    !member ||
    !expectedChannelId
  ) {
    return false;
  }

  if (
    member.voice?.channelId !==
    String(
      expectedChannelId
    )
  ) {
    return false;
  }

  try {
    await member.voice.disconnect(
      reason
    );

    return true;
  } catch (error) {
    logError(
      'SAFE_DISCONNECT_MEMBER',
      error
    );

    return false;
  }
}

async function safeEditChannel(
  channel,
  values,
  reason
) {
  if (!channel) {
    return null;
  }

  try {
    return await channel.edit(
      values,
      reason ||
      `${BOT_NAME} cập nhật phòng`
    );
  } catch (error) {
    logError(
      'SAFE_EDIT_CHANNEL',
      error
    );

    return null;
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
      reason ||
      `${BOT_NAME} xóa kênh`
    );

    return true;
  } catch (error) {
    if (
      !isUnknownDiscordResource(
        error
      )
    ) {
      logError(
        'SAFE_DELETE_CHANNEL',
        error
      );
    }

    return false;
  }
}

async function ensureOwnerDirectPermissions(
  channel,
  ownerId
) {
  const owner =
    await fetchMemberSafe(
      channel.guild,
      ownerId
    );

  if (!owner) {
    return false;
  }

  return grantRoomOwnerPermissions(
    channel,
    owner
  );
}

async function isRoomOwner(
  channelId,
  userId
) {
  const room =
    await getRoom(
      channelId
    );

  if (!room) {
    return false;
  }

  return (
    String(
      room.owner_id
    ) ===
    String(
      userId
    )
  );
}

async function interactionRoomContext(
  interaction
) {
  if (
    !interaction.guild ||
    !interaction.channel
  ) {
    return null;
  }

  const room =
    await getRoom(
      interaction.channel.id
    );

  if (!room) {
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

  const owner =
    await fetchMemberSafe(
      interaction.guild,
      room.owner_id
    );

  return {
    room,
    channel,
    owner
  };
}

async function requireRoomOwner(
  interaction
) {
  const context =
    await interactionRoomContext(
      interaction
    );

  if (!context) {
    await tempInteractionNotice(
      interaction,
      'Không tìm thấy phòng Voice HDK hợp lệ.',
      'error'
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
      'Chỉ chủ phòng hiện tại mới có thể dùng chức năng này.',
      'warning'
    );

    return null;
  }

  return context;
}

function setupMissingPermissionText(
  missing
) {
  if (
    !Array.isArray(
      missing
    ) ||
    missing.length ===
      0
  ) {
    return '';
  }

  return missing
    .map(
      name =>
        `• ${name}`
    )
    .join(
      '\n'
    );
}

async function validateSetupCategories(
  guild,
  buttonCategory,
  blogCategory
) {
  const result = {
    ok: true,
    guildMissing: [],
    buttonMissing: [],
    blogMissing: []
  };

  const guildCheck =
    await validateGuildBotPermissions(
      guild
    );

  if (
    !guildCheck.ok
  ) {
    result.ok =
      false;

    result.guildMissing =
      guildCheck.missing;
  }

  if (
    !isCategoryChannel(
      buttonCategory
    )
  ) {
    result.ok =
      false;

    result.buttonMissing = [
      'Danh mục không hợp lệ'
    ];
  } else {
    const check =
      await validateBotChannelPermissions(
        buttonCategory,
        {
          ViewChannel:
            PermissionsBitField.Flags.ViewChannel,
          ManageChannels:
            PermissionsBitField.Flags.ManageChannels,
          MoveMembers:
            PermissionsBitField.Flags.MoveMembers,
          Connect:
            PermissionsBitField.Flags.Connect
        }
      );

    if (
      !check.ok
    ) {
      result.ok =
        false;

      result.buttonMissing =
        check.missing;
    }
  }

  if (
    !isCategoryChannel(
      blogCategory
    )
  ) {
    result.ok =
      false;

    result.blogMissing = [
      'Danh mục không hợp lệ'
    ];
  } else {
    const check =
      await validateBotChannelPermissions(
        blogCategory,
        {
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
        }
      );

    if (
      !check.ok
    ) {
      result.ok =
        false;

      result.blogMissing =
        check.missing;
    }
  }

  return result;
}

function setupPermissionErrorText(
  result
) {
  const blocks = [];

  if (
    result.guildMissing?.length
  ) {
    blocks.push(
      'Quyền Bot còn thiếu:\n' +
      setupMissingPermissionText(
        result.guildMissing
      )
    );
  }

  if (
    result.buttonMissing?.length
  ) {
    blocks.push(
      'Danh mục đặt nút:\n' +
      setupMissingPermissionText(
        result.buttonMissing
      )
    );
  }

  if (
    result.blogMissing?.length
  ) {
    blocks.push(
      'Danh mục Blog:\n' +
      setupMissingPermissionText(
        result.blogMissing
      )
    );
  }

  return blocks.join(
    '\n\n'
  );
}

function roomNameFromMember(
  member
) {
  const base =
    cleanRoomName(
      safeMemberName(
        member
      )
    ) ||
    'Phòng mới';

  return (
    ROOM_PREFIX +
    base
  ).slice(
    0,
    100
  );
}

function ownerMentionText(
  ownerId
) {
  return (
    `<@${String(
      ownerId
    )}>`
  );
}

function clearStaleRuntimeState(
  channelId
) {
  clearEmptyRoomTimer(
    channelId
  );

  clearRuntimeOwnerAbsenceTimer(
    channelId
  );

  clearPendingTransfer(
    channelId
  );

  for (
    const key
    of selectedMembers.keys()
  ) {
    if (
      key.includes(
        `:${channelId}:`
      )
    ) {
      selectedMembers.delete(
        key
      );
    }
  }
}
const setupCleanupGuilds =
  new Set();

function setupPanelText(
  session
) {
  const displayName =
    cleanDisplayName(
      session?.displayName
    ) ||
    'Chưa nhập';

  const buttonCategory =
    session?.buttonCategoryId
      ? `<#${session.buttonCategoryId}>`
      : 'Chưa chọn';

  const blogCategory =
    session?.blogCategoryId
      ? `<#${session.blogCategoryId}>`
      : 'Chưa chọn';

  return [
    '⚙️  THIẾT LẬP VOICE HDK',
    '────────────────────────────',
    '',
    '🏷️ **Tên Server**',
    displayName,
    '',
    '📁 **Danh mục đặt nút**',
    buttonCategory,
    '',
    '📁 **Danh mục đặt Blog**',
    blogCategory,
    '',
    '────────────────────────────',
    'Chọn đầy đủ thông tin rồi nhấn **✅ Cài đặt**.'
  ].join('\n');
}

function buildSetupPanel(
  session
) {
  const renameButton =
    new ButtonBuilder()
      .setCustomId(
        'setup_name'
      )
      .setLabel(
        'Nhập / đổi tên Server'
      )
      .setEmoji('🏷️')
      .setStyle(
        ButtonStyle.Primary
      );

  const installButton =
    new ButtonBuilder()
      .setCustomId(
        'setup_install'
      )
      .setLabel(
        'Cài đặt'
      )
      .setEmoji('✅')
      .setStyle(
        ButtonStyle.Success
      );

  const cancelButton =
    new ButtonBuilder()
      .setCustomId(
        'setup_cancel'
      )
      .setLabel(
        'Hủy'
      )
      .setEmoji('✖️')
      .setStyle(
        ButtonStyle.Secondary
      );

  const buttonCategorySelect =
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
      .setMinValues(1)
      .setMaxValues(1);

  const blogCategorySelect =
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
      .setMinValues(1)
      .setMaxValues(1);

  return {
    content:
      setupPanelText(
        session
      ),
    components: [
      new ActionRowBuilder()
        .addComponents(
          renameButton
        ),

      new ActionRowBuilder()
        .addComponents(
          buttonCategorySelect
        ),

      new ActionRowBuilder()
        .addComponents(
          blogCategorySelect
        ),

      new ActionRowBuilder()
        .addComponents(
          installButton,
          cancelButton
        )
    ],
    allowedMentions: {
      parse: []
    }
  };
}

function buildSetupNameModal(
  currentName
) {
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
      .setStyle(
        TextInputStyle.Short
      )
      .setPlaceholder(
        'Ví dụ: ABCD'
      )
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(50);

  const value =
    cleanDisplayName(
      currentName
    );

  if (value) {
    input.setValue(
      value
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

function buildReinstallPanel() {
  const reinstall =
    new ButtonBuilder()
      .setCustomId(
        'setup_reinstall_confirm'
      )
      .setLabel(
        'Cài đặt lại'
      )
      .setEmoji('♻️')
      .setStyle(
        ButtonStyle.Primary
      );

  const cancel =
    new ButtonBuilder()
      .setCustomId(
        'setup_reinstall_cancel'
      )
      .setLabel(
        'Hủy'
      )
      .setEmoji('✖️')
      .setStyle(
        ButtonStyle.Secondary
      );

  return {
    content: [
      '⚠️ **CÀI ĐẶT LẠI VOICE HDK**',
      '',
      'Server này đã được cài đặt Voice HDK.',
      '',
      'Tiếp tục sẽ xóa hệ thống Voice HDK cũ',
      'và cho phép bạn thiết lập lại từ đầu.'
    ].join('\n'),

    components: [
      new ActionRowBuilder()
        .addComponents(
          reinstall,
          cancel
        )
    ],

    allowedMentions: {
      parse: []
    }
  };
}

function setupSuccessText() {
  return [
    '🎉 **CÀI ĐẶT VOICE HDK THÀNH CÔNG!**',
    '',
    'Chúc mừng! Voice HDK đã được cài đặt thành công',
    'và hiện đã sẵn sàng để sử dụng.',
    '',
    'Nếu có bất kỳ thắc mắc hoặc cần hỗ trợ:',
    '👤 Huỳnh Duy Khánh',
    '☎️ 0988850044',
    '',
    'Cảm ơn bạn đã sử dụng Voice HDK ❤️'
  ].join('\n');
}

function setupSessionFromGenerator(
  generator
) {
  return {
    displayName:
      cleanDisplayName(
        generator?.display_name
      ),

    buttonCategoryId:
      generator?.button_category_id
        ? String(
            generator.button_category_id
          )
        : null,

    blogCategoryId:
      generator?.blog_category_id
        ? String(
            generator.blog_category_id
          )
        : null
  };
}

async function fetchSetupPanelMessage(
  guild,
  session
) {
  if (
    !guild ||
    !session?.panelChannelId ||
    !session?.panelMessageId
  ) {
    return null;
  }

  const channel =
    await fetchChannelSafe(
      guild,
      session.panelChannelId
    );

  if (
    !channel?.isTextBased?.()
  ) {
    return null;
  }

  return fetchMessageSafe(
    channel,
    session.panelMessageId
  );
}

async function refreshSetupPanel(
  guildId,
  userId
) {
  const session =
    getSetupSession(
      guildId,
      userId
    );

  if (!session) {
    return false;
  }

  const guild =
    client.guilds.cache.get(
      guildId
    );

  if (!guild) {
    return false;
  }

  const message =
    await fetchSetupPanelMessage(
      guild,
      session
    );

  if (!message) {
    return false;
  }

  try {
    await message.edit(
      buildSetupPanel(
        session
      )
    );

    return true;
  } catch (error) {
    logError(
      'REFRESH_SETUP_PANEL',
      error
    );

    return false;
  }
}

async function beginFreshSetup(
  interaction,
  seed = {}
) {
  const session =
    setSetupSession(
      interaction.guildId,
      interaction.user.id,
      {
        displayName:
          cleanDisplayName(
            seed.displayName
          ),

        buttonCategoryId:
          seed.buttonCategoryId ||
          null,

        blogCategoryId:
          seed.blogCategoryId ||
          null,

        panelChannelId:
          interaction.channelId,

        panelMessageId:
          null
      }
    );

  let message;

  if (
    interaction.deferred ||
    interaction.replied
  ) {
    message =
      await interaction.editReply(
        buildSetupPanel(
          session
        )
      );
  } else {
    message =
      await interaction.reply({
        ...buildSetupPanel(
          session
        ),
        ephemeral:
          true,
        fetchReply:
          true
      });
  }

  if (
    message?.id
  ) {
    setSetupSession(
      interaction.guildId,
      interaction.user.id,
      {
        panelChannelId:
          interaction.channelId,
        panelMessageId:
          message.id
      }
    );
  }

  return message;
}

async function handleSetupCommand(
  interaction
) {
  if (
    !interaction.inGuild()
  ) {
    return tempReply(
      interaction,
      'Lệnh này chỉ dùng trong Server Discord.',
      'warning'
    );
  }

  if (
    !interaction.memberPermissions?.has(
      PermissionsBitField.Flags.ManageGuild
    )
  ) {
    return tempReply(
      interaction,
      'Bạn cần quyền Quản lý Server để cài đặt Voice HDK.',
      'warning'
    );
  }

  const guildPermissionCheck =
    await validateGuildBotPermissions(
      interaction.guild
    );

  if (
    !guildPermissionCheck.ok
  ) {
    return tempReply(
      interaction,
      [
        'Bot đang thiếu quyền cần thiết:',
        '',
        setupMissingPermissionText(
          guildPermissionCheck.missing
        )
      ].join('\n'),
      'error'
    );
  }

  const existing =
    await getGenerator(
      interaction.guildId
    );

  if (existing) {
    clearSetupSession(
      interaction.guildId,
      interaction.user.id
    );

    return interaction.reply({
      ...buildReinstallPanel(),
      ephemeral:
        true
    });
  }

  return beginFreshSetup(
    interaction
  );
}

async function handleSetupNameButton(
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
      'Phiên cài đặt đã hết hạn. Hãy dùng lại /setup.',
      'warning'
    );
  }

  try {
    await interaction.showModal(
      buildSetupNameModal(
        session.displayName
      )
    );
  } catch (error) {
    logError(
      'SETUP_NAME_BUTTON',
      error
    );
  }
}

async function handleSetupNameModal(
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
      'Phiên cài đặt đã hết hạn. Hãy dùng lại /setup.',
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
      'Tên Server không được để trống.',
      'warning'
    );
  }

  setSetupSession(
    interaction.guildId,
    interaction.user.id,
    {
      displayName
    }
  );

  try {
    await interaction.deferReply({
      ephemeral:
        true
    });
  } catch (error) {
    logError(
      'SETUP_NAME_DEFER',
      error
    );

    return;
  }

  const refreshed =
    await refreshSetupPanel(
      interaction.guildId,
      interaction.user.id
    );

  if (!refreshed) {
    return tempReply(
      interaction,
      'Đã lưu tên nhưng không thể làm mới bảng cài đặt. Hãy chạy lại /setup nếu cần.',
      'warning'
    );
  }

  return tempReply(
    interaction,
    'Đã cập nhật tên hiển thị.',
    'success'
  );
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
    return tempReply(
      interaction,
      'Phiên cài đặt đã hết hạn. Hãy dùng lại /setup.',
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
    return tempReply(
      interaction,
      'Danh mục đặt nút không hợp lệ.',
      'error'
    );
  }

  setSetupSession(
    interaction.guildId,
    interaction.user.id,
    {
      buttonCategoryId:
        category.id
    }
  );

  await acknowledgeComponent(
    interaction
  );

  await refreshSetupPanel(
    interaction.guildId,
    interaction.user.id
  );
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
    return tempReply(
      interaction,
      'Phiên cài đặt đã hết hạn. Hãy dùng lại /setup.',
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
    return tempReply(
      interaction,
      'Danh mục Blog không hợp lệ.',
      'error'
    );
  }

  setSetupSession(
    interaction.guildId,
    interaction.user.id,
    {
      blogCategoryId:
        category.id
    }
  );

  await acknowledgeComponent(
    interaction
  );

  await refreshSetupPanel(
    interaction.guildId,
    interaction.user.id
  );
}

async function handleSetupCancel(
  interaction
) {
  clearSetupSession(
    interaction.guildId,
    interaction.user.id
  );

  try {
    await interaction.update({
      content:
        '✖️ Đã hủy thiết lập Voice HDK.',
      components: []
    });
  } catch (error) {
    logError(
      'SETUP_CANCEL',
      error
    );
  }

  deleteInteractionOriginalLater(
    interaction,
    NOTICE_DELETE_MS
  );
}

async function cleanupManagedGuild(
  guild,
  generator
) {
  if (
    !guild ||
    !generator
  ) {
    return;
  }

  const guildId =
    guild.id;

  setupCleanupGuilds.add(
    guildId
  );

  try {
    const rooms =
      await getGuildRooms(
        guildId
      );

    const roomChannelIds =
      rooms
        .map(
          room =>
            String(
              room.channel_id
            )
        )
        .filter(
          isSnowflake
        );

    const trackedChannelIds =
      [
        generator.create_voice_id,
        generator.chat_log_channel_id,
        generator.action_log_channel_id
      ]
        .filter(Boolean)
        .map(String)
        .filter(
          isSnowflake
        );

    const dbClient =
      await pool.connect();

    try {
      await dbClient.query(
        'BEGIN'
      );

      await deleteGuildRoomRecords(
        guildId,
        dbClient
      );

      await deleteGenerator(
        guildId,
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

    for (
      const channelId
      of roomChannelIds
    ) {
      clearStaleRuntimeState(
        channelId
      );
    }

    for (
      const channelId
      of [
        ...roomChannelIds,
        ...trackedChannelIds
      ]
    ) {
      const channel =
        await fetchChannelSafe(
          guild,
          channelId
        );

      if (!channel) {
        continue;
      }

      await safeDeleteChannel(
        channel,
        `${BOT_NAME} cài đặt lại hệ thống`
      );
    }
  } finally {
    const timer =
      setTimeout(
        () => {
          setupCleanupGuilds.delete(
            guildId
          );
        },
        3000
      );

    timer.unref?.();
  }
}

async function handleSetupReinstallConfirm(
  interaction
) {
  if (
    !interaction.memberPermissions?.has(
      PermissionsBitField.Flags.ManageGuild
    )
  ) {
    return tempReply(
      interaction,
      'Bạn cần quyền Quản lý Server để cài đặt lại Voice HDK.',
      'warning'
    );
  }

  const generator =
    await getGenerator(
      interaction.guildId
    );

  try {
    await interaction.deferUpdate();
  } catch (error) {
    logError(
      'REINSTALL_DEFER',
      error
    );

    return;
  }

  try {
    if (generator) {
      await cleanupManagedGuild(
        interaction.guild,
        generator
      );
    }

    clearSetupSession(
      interaction.guildId,
      interaction.user.id
    );

    const session =
      setSetupSession(
        interaction.guildId,
        interaction.user.id,
        {
          displayName:
            '',

          buttonCategoryId:
            null,

          blogCategoryId:
            null,

          panelChannelId:
            interaction.channelId,

          panelMessageId:
            interaction.message?.id ||
            null
        }
      );

    await interaction.editReply(
      buildSetupPanel(
        session
      )
    );

    if (
      interaction.message?.id
    ) {
      setSetupSession(
        interaction.guildId,
        interaction.user.id,
        {
          panelMessageId:
            interaction.message.id
        }
      );
    }
  } catch (error) {
    logError(
      'SETUP_REINSTALL',
      error
    );

    await tempFollowUp(
      interaction,
      'Không thể hoàn tất quá trình cài đặt lại. Hệ thống đã dừng để tránh xóa nhầm tài nguyên.',
      'error'
    );
  }
}

async function handleSetupReinstallCancel(
  interaction
) {
  try {
    await interaction.update({
      content:
        '✖️ Đã hủy cài đặt lại. Hệ thống hiện tại được giữ nguyên.',
      components: []
    });
  } catch (error) {
    logError(
      'REINSTALL_CANCEL',
      error
    );
  }

  deleteInteractionOriginalLater(
    interaction,
    NOTICE_DELETE_MS
  );
}

async function findExistingManagedChild(
  guild,
  categoryId,
  channelName,
  channelType
) {
  const channels =
    guild.channels.cache.filter(
      channel =>
        channel.parentId ===
          String(
            categoryId
          ) &&
        channel.name ===
          channelName &&
        channel.type ===
          channelType
    );

  return (
    channels.first() ||
    null
  );
}

async function createManagedVoiceGenerator(
  guild,
  category
) {
  const existing =
    await findExistingManagedChild(
      guild,
      category.id,
      CREATE_VOICE_NAME,
      ChannelType.GuildVoice
    );

  if (existing) {
    return existing;
  }

  return guild.channels.create({
    name:
      CREATE_VOICE_NAME,

    type:
      ChannelType.GuildVoice,

    parent:
      category.id,

    userLimit:
      0,

    reason:
      `${BOT_NAME} tạo Voice Generator`
  });
}

async function createManagedLogChannel(
  guild,
  category,
  name
) {
  const existing =
    await findExistingManagedChild(
      guild,
      category.id,
      name,
      ChannelType.GuildText
    );

  if (existing) {
    return existing;
  }

  return guild.channels.create({
    name,
    type:
      ChannelType.GuildText,
    parent:
      category.id,
    reason:
      `${BOT_NAME} tạo kênh nhật ký`
  });
}

async function rollbackNewSetupChannels(
  channels
) {
  for (
    const channel
    of channels.reverse()
  ) {
    if (!channel) {
      continue;
    }

    await safeDeleteChannel(
      channel,
      `${BOT_NAME} hoàn tác cài đặt chưa hoàn tất`
    );
  }
}

async function handleSetupInstall(
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
      'Phiên cài đặt đã hết hạn. Hãy dùng lại /setup.',
      'warning'
    );
  }

  if (
    !interaction.memberPermissions?.has(
      PermissionsBitField.Flags.ManageGuild
    )
  ) {
    return tempReply(
      interaction,
      'Bạn cần quyền Quản lý Server để cài đặt Voice HDK.',
      'warning'
    );
  }

  if (
    !session.displayName
  ) {
    return tempReply(
      interaction,
      'Hãy nhập Tên Server trước khi cài đặt.',
      'warning'
    );
  }

  if (
    !session.buttonCategoryId
  ) {
    return tempReply(
      interaction,
      'Hãy chọn Danh mục đặt nút.',
      'warning'
    );
  }

  if (
    !session.blogCategoryId
  ) {
    return tempReply(
      interaction,
      'Hãy chọn Danh mục đặt Blog.',
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
    return tempReply(
      interaction,
      'Một trong hai danh mục đã bị xóa hoặc không còn hợp lệ.',
      'error'
    );
  }

  const permissionCheck =
    await validateSetupCategories(
      interaction.guild,
      buttonCategory,
      blogCategory
    );

  if (
    !permissionCheck.ok
  ) {
    return tempReply(
      interaction,
      [
        'Không thể cài đặt vì Bot còn thiếu quyền.',
        '',
        setupPermissionErrorText(
          permissionCheck
        )
      ].join('\n'),
      'error'
    );
  }

  const alreadyInstalled =
    await getGenerator(
      interaction.guildId
    );

  if (alreadyInstalled) {
    return tempReply(
      interaction,
      'Voice HDK đã được cài đặt. Hãy dùng /setup và chọn Cài đặt lại nếu muốn thiết lập lại.',
      'warning'
    );
  }

  try {
    await interaction.deferUpdate();
  } catch (error) {
    logError(
      'SETUP_INSTALL_DEFER',
      error
    );

    return;
  }

  const createdByThisInstall =
    [];

  try {
    let createVoice =
      await findExistingManagedChild(
        interaction.guild,
        buttonCategory.id,
        CREATE_VOICE_NAME,
        ChannelType.GuildVoice
      );

    if (!createVoice) {
      createVoice =
        await createManagedVoiceGenerator(
          interaction.guild,
          buttonCategory
        );

      createdByThisInstall.push(
        createVoice
      );
    }

    let chatLog =
      await findExistingManagedChild(
        interaction.guild,
        blogCategory.id,
        CHAT_LOG_CHANNEL_NAME,
        ChannelType.GuildText
      );

    if (!chatLog) {
      chatLog =
        await createManagedLogChannel(
          interaction.guild,
          blogCategory,
          CHAT_LOG_CHANNEL_NAME
        );

      createdByThisInstall.push(
        chatLog
      );
    }

    let actionLog =
      await findExistingManagedChild(
        interaction.guild,
        blogCategory.id,
        ACTION_LOG_CHANNEL_NAME,
        ChannelType.GuildText
      );

    if (!actionLog) {
      actionLog =
        await createManagedLogChannel(
          interaction.guild,
          blogCategory,
          ACTION_LOG_CHANNEL_NAME
        );

      createdByThisInstall.push(
        actionLog
      );
    }

    await saveGenerator({
      guildId:
        interaction.guildId,

      displayName:
        cleanDisplayName(
          session.displayName
        ),

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

    clearSetupSession(
      interaction.guildId,
      interaction.user.id
    );

    await interaction.editReply({
      content:
        setupSuccessText(),

      components: [],

      allowedMentions: {
        parse: []
      }
    });
  } catch (error) {
    logError(
      'SETUP_INSTALL',
      error
    );

    await rollbackNewSetupChannels(
      createdByThisInstall
    );

    await tempFollowUp(
      interaction,
      'Cài đặt chưa hoàn tất. Những kênh vừa được Bot tạo trong lần thử này đã được hoàn tác.',
      'error'
    );
  }
}

async function ensureGeneratorVoiceChannel(
  guild,
  generator
) {
  if (
    !guild ||
    !generator
  ) {
    return null;
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
    return null;
  }

  let createVoice =
    await fetchChannelSafe(
      guild,
      generator.create_voice_id
    );

  if (
    isVoiceChannel(
      createVoice
    ) &&
    createVoice.parentId ===
      category.id
  ) {
    return createVoice;
  }

  createVoice =
    await createManagedVoiceGenerator(
      guild,
      category
    );

  await pool.query(
    `
      UPDATE generators
      SET
        create_voice_id = $2,
        updated_at = NOW()
      WHERE guild_id = $1
    `,
    [
      guild.id,
      createVoice.id
    ]
  );

  return createVoice;
}

async function ensureManagedLogChannels(
  guild,
  generator
) {
  if (
    !guild ||
    !generator
  ) {
    return {
      chatLog:
        null,
      actionLog:
        null
    };
  }

  const category =
    await fetchChannelSafe(
      guild,
      generator.blog_category_id
    );

  if (
    !isCategoryChannel(
      category
    )
  ) {
    return {
      chatLog:
        null,
      actionLog:
        null
    };
  }

  let chatLog =
    await fetchChannelSafe(
      guild,
      generator.chat_log_channel_id
    );

  if (
    !isGuildTextChannel(
      chatLog
    ) ||
    chatLog.parentId !==
      category.id
  ) {
    chatLog =
      await createManagedLogChannel(
        guild,
        category,
        CHAT_LOG_CHANNEL_NAME
      );
  }

  let actionLog =
    await fetchChannelSafe(
      guild,
      generator.action_log_channel_id
    );

  if (
    !isGuildTextChannel(
      actionLog
    ) ||
    actionLog.parentId !==
      category.id
  ) {
    actionLog =
      await createManagedLogChannel(
        guild,
        category,
        ACTION_LOG_CHANNEL_NAME
      );
  }

  await pool.query(
    `
      UPDATE generators
      SET
        chat_log_channel_id = $2,
        action_log_channel_id = $3,
        updated_at = NOW()
      WHERE guild_id = $1
    `,
    [
      guild.id,
      chatLog.id,
      actionLog.id
    ]
  );

  return {
    chatLog,
    actionLog
  };
}
function humanMembers(
  channel
) {
  return channelHumanMembers(
    channel
  );
}

function roomIsLocked(
  channel
) {
  if (
    !channel?.guild
  ) {
    return false;
  }

  const overwrite =
    channel.permissionOverwrites
      ?.cache
      ?.get(
        channel.guild.id
      );

  if (!overwrite) {
    return false;
  }

  return overwrite.deny.has(
    PermissionsBitField.Flags.Connect
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

  const overwrite =
    channel.permissionOverwrites
      ?.cache
      ?.get(
        channel.guild.id
      );

  if (!overwrite) {
    return false;
  }

  return overwrite.deny.has(
    PermissionsBitField.Flags.ViewChannel
  );
}

function roomRegionText(
  channel
) {
  const value =
    cleanDisplayName(
      channel?.rtcRegion
    );

  if (!value) {
    return 'Tự động';
  }

  return value
    .split('-')
    .map(
      part =>
        part
          .charAt(0)
          .toUpperCase() +
        part
          .slice(1)
    )
    .join(' ');
}

async function buildRoomDashboard(
  room,
  channel
) {
  const generator =
    await getGenerator(
      room.guild_id
    );

  const owner =
    await fetchMemberSafe(
      channel.guild,
      room.owner_id
    );

  const ownerName =
    owner
      ? safeMemberName(
          owner
        )
      : 'Không xác định';

  const members =
    humanMembers(
      channel
    );

  const memberCount =
    members.length;

  const limit =
    Number(
      channel.userLimit ||
      0
    );

  const limitText =
    limit > 0
      ? `${memberCount} / ${limit}`
      : `${memberCount} / ∞`;

  const locked =
    roomIsLocked(
      channel
    );

  const hidden =
    roomIsHidden(
      channel
    );

  const displayName =
    cleanDisplayName(
      generator?.display_name
    ) ||
    'Voice HDK';

  return [
    `🔊  PHÒNG CỦA ${ownerName.toUpperCase()}`,
    '────────────────────────────',
    `👑 Chủ phòng    @${ownerName}`,
    `👥 Thành viên   ${limitText}`,
    `${locked ? '🔒' : '🔓'} Phòng        ${locked ? 'Đang khóa' : 'Đang mở'}`,
    `${hidden ? '🙈' : '👁️'} Hiển thị     ${hidden ? 'Đang ẩn' : 'Công khai'}`,
    `🌐 Khu vực      ${roomRegionText(channel)}`,
    '────────────────────────────',
    `✦ Voice HDK • ${displayName}`
  ].join('\n');
}

function buildRoomButtons(
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

  const lockButton =
    new ButtonBuilder()
      .setCustomId(
        'room_lock'
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
          : ButtonStyle.Primary
      );

  const hideButton =
    new ButtonBuilder()
      .setCustomId(
        'room_hide'
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
          : ButtonStyle.Primary
      );

  const renameButton =
    new ButtonBuilder()
      .setCustomId(
        'room_rename'
      )
      .setLabel(
        'Đổi tên'
      )
      .setEmoji('✏️')
      .setStyle(
        ButtonStyle.Primary
      );

  const resetButton =
    new ButtonBuilder()
      .setCustomId(
        'room_reset'
      )
      .setLabel(
        'Đặt lại'
      )
      .setEmoji('♻️')
      .setStyle(
        ButtonStyle.Primary
      );

  const limitButton =
    new ButtonBuilder()
      .setCustomId(
        'room_limit'
      )
      .setLabel(
        'Giới hạn'
      )
      .setEmoji('👥')
      .setStyle(
        ButtonStyle.Primary
      );

  const inviteButton =
    new ButtonBuilder()
      .setCustomId(
        'room_invite'
      )
      .setLabel(
        'Mời'
      )
      .setEmoji('✉️')
      .setStyle(
        ButtonStyle.Success
      );

  const transferButton =
    new ButtonBuilder()
      .setCustomId(
        'room_transfer'
      )
      .setLabel(
        'Chuyển chủ'
      )
      .setEmoji('👑')
      .setStyle(
        ButtonStyle.Primary
      );

  const denyButton =
    new ButtonBuilder()
      .setCustomId(
        'room_deny'
      )
      .setLabel(
        'Cấm'
      )
      .setEmoji('⛔')
      .setStyle(
        ButtonStyle.Primary
      );

  const kickButton =
    new ButtonBuilder()
      .setCustomId(
        'room_kick'
      )
      .setLabel(
        'Đuổi'
      )
      .setEmoji('👢')
      .setStyle(
        ButtonStyle.Primary
      );

  return [
    new ActionRowBuilder()
      .addComponents(
        lockButton,
        hideButton,
        renameButton
      ),

    new ActionRowBuilder()
      .addComponents(
        resetButton,
        limitButton,
        inviteButton
      ),

    new ActionRowBuilder()
      .addComponents(
        transferButton,
        denyButton,
        kickButton
      )
  ];
}

function buildMemberSelectRow() {
  const select =
    new UserSelectMenuBuilder()
      .setCustomId(
        'room_member'
      )
      .setPlaceholder(
        '👤 Chọn thành viên'
      )
      .setMinValues(1)
      .setMaxValues(1);

  return new ActionRowBuilder()
    .addComponents(
      select
    );
}

function compactRegionLabel(
  name
) {
  const clean =
    cleanDisplayName(
      name
    );

  if (!clean) {
    return 'Khu vực';
  }

  return clean.slice(
    0,
    50
  );
}

async function buildRegionSelectRow(
  channel
) {
  const regions =
    await fetchVoiceRegionsSafe(
      false
    );

  const current =
    channel.rtcRegion ||
    'automatic';

  const options = [
    {
      label:
        'Tự động',
      value:
        'automatic',
      emoji:
        '🌐',
      default:
        current ===
        'automatic'
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
        compactRegionLabel(
          region.name ||
          region.id
        ),

      value:
        String(
          region.id
        ).slice(
          0,
          100
        ),

      emoji:
        '🌎',

      default:
        current ===
        region.id
    });
  }

  const placeholder =
    current ===
    'automatic'
      ? '🌐 Tự động'
      : `🌐 ${roomRegionText(channel)}`;

  const select =
    new StringSelectMenuBuilder()
      .setCustomId(
        'room_region'
      )
      .setPlaceholder(
        placeholder.slice(
          0,
          150
        )
      )
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        options
      );

  return new ActionRowBuilder()
    .addComponents(
      select
    );
}

async function buildRoomPanelPayload(
  room,
  channel
) {
  const dashboard =
    await buildRoomDashboard(
      room,
      channel
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
    content:
      `\`\`\`\n${dashboard}\n\`\`\``,

    components: [
      ...buttonRows,
      memberRow,
      regionRow
    ],

    allowedMentions: {
      parse: []
    }
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

  const components =
    message.components ||
    [];

  const customIds = [];

  for (
    const row
    of components
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
    customIds.includes(
      'room_member'
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
    !channel?.isTextBased?.()
  ) {
    return [];
  }

  try {
    const messages =
      await channel.messages.fetch({
        limit:
          50
      });

    return [
      ...messages.values()
    ]
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
      'FIND_ROOM_PANELS',
      error
    );

    return [];
  }
}

async function deleteDuplicatePanels(
  panels,
  keepMessageId
) {
  for (
    const message
    of panels
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

async function refreshRoomPanelSafe(
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
          room.channel_id
        );

      if (
        !isVoiceChannel(
          channel
        )
      ) {
        return null;
      }

      const payload =
        await buildRoomPanelPayload(
          room,
          channel
        );

      let panelMessage =
        null;

      if (
        room.control_message_id
      ) {
        panelMessage =
          await fetchMessageSafe(
            channel,
            room.control_message_id
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

      let discoveredPanels =
        [];

      if (!panelMessage) {
        discoveredPanels =
          await findRoomPanelMessages(
            channel
          );

        panelMessage =
          discoveredPanels[0] ||
          null;

        if (panelMessage) {
          await setControlMessage(
            channel.id,
            panelMessage.id
          );
        }
      }

      if (panelMessage) {
        try {
          await panelMessage.edit(
            payload
          );
        } catch (error) {
          if (
            !isUnknownDiscordResource(
              error
            )
          ) {
            logError(
              'EDIT_ROOM_PANEL',
              error
            );
          }

          panelMessage =
            null;
        }
      }

      if (!panelMessage) {
        try {
          panelMessage =
            await channel.send(
              payload
            );

          await setControlMessage(
            channel.id,
            panelMessage.id
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
        discoveredPanels.length ===
        0
      ) {
        discoveredPanels =
          await findRoomPanelMessages(
            channel
          );
      }

      await deleteDuplicatePanels(
        discoveredPanels,
        panelMessage.id
      );

      return panelMessage;
    }
  );
}

async function getExistingOwnedChannel(
  guild,
  memberId
) {
  const ownedRoom =
    await getOwnedRoom(
      guild.id,
      memberId
    );

  if (!ownedRoom) {
    return null;
  }

  const channel =
    await fetchChannelSafe(
      guild,
      ownedRoom.channel_id
    );

  if (
    isVoiceChannel(
      channel
    )
  ) {
    return {
      room:
        ownedRoom,
      channel
    };
  }

  clearStaleRuntimeState(
    ownedRoom.channel_id
  );

  await deleteRoomRecord(
    ownedRoom.channel_id
  );

  return null;
}

async function createPersonalVoiceRoom(
  member,
  generator
) {
  const guild =
    member.guild;

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
    throw new Error(
      'Danh mục đặt nút không còn tồn tại.'
    );
  }

  const existing =
    await getExistingOwnedChannel(
      guild,
      member.id
    );

  if (existing) {
    return {
      ...existing,
      created:
        false
    };
  }

  let channel =
    null;

  let roomSaved =
    false;

  try {
    channel =
      await guild.channels.create({
        name:
          roomNameFromMember(
            member
          ),

        type:
          ChannelType.GuildVoice,

        parent:
          category.id,

        userLimit:
          0,

        reason:
          `${BOT_NAME} tạo phòng cho ${safeMemberName(member)}`
      });

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

    roomSaved =
      true;

    await grantRoomOwnerPermissions(
      channel,
      member
    );

    /*
      Quan trọng:
      Tạo panel TRƯỚC khi kéo người dùng
      vào phòng mới.
    */
    await refreshRoomPanelSafe(
      channel.id
    );

    const room =
      await getRoom(
        channel.id
      );

    return {
      room,
      channel,
      created:
        true
    };
  } catch (error) {
    logError(
      'CREATE_PERSONAL_ROOM',
      error
    );

    if (
      roomSaved &&
      channel
    ) {
      await deleteRoomRecord(
        channel.id
      ).catch(
        () => {}
      );
    }

    if (channel) {
      await safeDeleteChannel(
        channel,
        `${BOT_NAME} hoàn tác phòng tạo lỗi`
      );
    }

    throw error;
  }
}

async function syncCurrentRoomPresence(
  channel
) {
  if (
    !isVoiceChannel(
      channel
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

  let offset =
    0;

  for (
    const member
    of humans
  ) {
    const alreadyStored =
      stored.some(
        row =>
          String(
            row.member_id
          ) ===
          String(
            member.id
          )
      );

    if (alreadyStored) {
      continue;
    }

    await recordMemberPresence(
      channel.guild.id,
      channel.id,
      member.id,
      new Date(
        Date.now() +
        offset
      )
    );

    offset +=
      5;
  }
}

async function recordVoiceJoinIfManaged(
  channel,
  member
) {
  if (
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

  await recordMemberPresence(
    channel.guild.id,
    channel.id,
    member.id,
    new Date()
  );
}

async function recordVoiceLeaveIfManaged(
  channel,
  member
) {
  if (
    !isVoiceChannel(
      channel
    ) ||
    !member
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
}

async function handleJoinCreateVoice(
  voiceState
) {
  const guild =
    voiceState.guild;

  const member =
    voiceState.member;

  if (
    !guild ||
    !member ||
    member.user?.bot
  ) {
    return false;
  }

  const generator =
    await getGenerator(
      guild.id
    );

  if (
    !generator?.create_voice_id ||
    String(
      voiceState.channelId
    ) !==
      String(
        generator.create_voice_id
      )
  ) {
    return false;
  }

  return withCreateLock(
    guild.id,
    member.id,
    async () => {
      const freshMember =
        await fetchMemberSafe(
          guild,
          member.id
        );

      if (!freshMember) {
        return true;
      }

      /*
        Nếu event đã cũ và user không còn
        ở generator nữa thì không tạo phòng.
      */
      if (
        String(
          freshMember.voice?.channelId ||
          ''
        ) !==
        String(
          generator.create_voice_id
        )
      ) {
        return true;
      }

      let result =
        await getExistingOwnedChannel(
          guild,
          freshMember.id
        );

      if (result) {
        /*
          Người dùng đã sở hữu phòng:
          KHÔNG tạo phòng thứ hai.
          Panel cũ được tự sửa nếu cần,
          sau đó đưa họ về phòng đang sở hữu.
        */
        await refreshRoomPanelSafe(
          result.channel.id
        );

        const moved =
          await safeMoveMember(
            freshMember,
            result.channel,
            `${BOT_NAME} đưa chủ phòng về phòng hiện có`
          );

        if (moved) {
          await recordMemberPresence(
            guild.id,
            result.channel.id,
            freshMember.id,
            new Date()
          );

          await cancelOwnerAbsence(
            result.channel.id,
            {
              ownerReturned:
                true,
              member:
                freshMember
            }
          ).catch(
            error => {
              logError(
                'CANCEL_ABSENCE_EXISTING_ROOM',
                error
              );
            }
          );

          await refreshRoomPanelSafe(
            result.channel.id
          );
        }

        return true;
      }

      try {
        result =
          await createPersonalVoiceRoom(
            freshMember,
            generator
          );
      } catch (error) {
        logError(
          'HANDLE_GENERATOR_CREATE',
          error
        );

        /*
          Không có text spam trong generator.
          Nếu tạo thất bại user vẫn ở generator,
          event khác/reconcile không tự tạo trùng
          nhờ create lock + unique DB.
        */
        return true;
      }

      if (
        !result?.channel
      ) {
        return true;
      }

      /*
        Đến đây panel đã được tạo.
        Bây giờ mới kéo user vào phòng.
      */
      const moved =
        await safeMoveMember(
          freshMember,
          result.channel,
          `${BOT_NAME} đưa chủ phòng vào phòng mới`
        );

      if (!moved) {
        /*
          Nếu không kéo được user:
          phòng mới đang rỗng nên cho quy trình
          xóa phòng rỗng dọn an toàn.
        */
        scheduleEmptyRoomCheck(
          result.channel.id
        );

        return true;
      }

      await recordMemberPresence(
        guild.id,
        result.channel.id,
        freshMember.id,
        new Date()
      );

      await refreshRoomPanelSafe(
        result.channel.id
      );

      if (
        result.created
      ) {
        await sendActionLog(
          guild,
          `➕ ${safeMemberName(freshMember)} » Tạo phòng ${result.channel.name}`
        ).catch(
          error => {
            logError(
              'LOG_ROOM_CREATE',
              error
            );
          }
        );
      }

      return true;
    }
  );
}

async function deleteEmptyRoom(
  channelId
) {
  return withRoomLifecycleLock(
    channelId,
    async () => {
      clearEmptyRoomTimer(
        channelId
      );

      const room =
        await getRoom(
          channelId
        );

      if (!room) {
        clearStaleRuntimeState(
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
        await fetchChannelSafe(
          guild,
          channelId
        );

      if (!channel) {
        /*
          Channel đã mất thật sự:
          lúc này mới xóa DB.
        */
        clearStaleRuntimeState(
          channelId
        );

        await deleteRoomRecord(
          channelId
        );

        return true;
      }

      if (
        !isVoiceChannel(
          channel
        )
      ) {
        return false;
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

      /*
        Hủy các runtime state trước,
        nhưng CHƯA xóa record DB.

        Nếu Discord từ chối xóa channel,
        record DB vẫn còn để bot có thể
        tiếp tục quản lý/retry.
      */
      clearRuntimeOwnerAbsenceTimer(
        channelId
      );

      clearPendingTransfer(
        channelId
      );

      const deleted =
        await safeDeleteChannel(
          channel,
          `${BOT_NAME} tự xóa phòng rỗng`
        );

      if (!deleted) {
        /*
          Không xóa DB nếu channel Discord
          vẫn còn tồn tại.
        */
        scheduleEmptyRoomCheck(
          channelId,
          5000
        );

        return false;
      }

      /*
        ChannelDelete event cũng có thể chạy.
        deleteRoomRecord idempotent nên gọi lại
        vẫn an toàn.
      */
      await deleteRoomRecord(
        channelId
      ).catch(
        error => {
          logError(
            'DELETE_EMPTY_ROOM_DB',
            error
          );
        }
      );

      clearStaleRuntimeState(
        channelId
      );

      await sendActionLog(
        guild,
        `🗑️ Voice HDK » Xóa phòng ${channelName}`
      ).catch(
        error => {
          logError(
            'LOG_EMPTY_ROOM_DELETE',
            error
          );
        }
      );

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
      async () => {
        emptyRoomTimers.delete(
          String(
            channelId
          )
        );

        try {
          await deleteEmptyRoom(
            channelId
          );
        } catch (error) {
          logError(
            'EMPTY_ROOM_CHECK',
            error
          );
        }
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
  channel
) {
  if (
    !isVoiceChannel(
      channel
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
    !interaction.inGuild()
  ) {
    await tempInteractionNotice(
      interaction,
      'Chức năng này chỉ dùng trong Server.',
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
      'Bảng điều khiển này không còn nằm trong phòng thoại hợp lệ.',
      'error'
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
      'error'
    );

    return null;
  }

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
      'Chỉ chủ phòng hiện tại mới có thể sử dụng chức năng này.',
      'warning'
    );

    return null;
  }

  const member =
    await fetchMemberSafe(
      interaction.guild,
      interaction.user.id
    );

  if (!member) {
    await tempInteractionNotice(
      interaction,
      'Không thể xác minh thành viên hiện tại.',
      'error'
    );

    return null;
  }

  return {
    room,
    channel,
    member
  };
}

async function getRequiredSelectedMember(
  interaction,
  context,
  {
    requireSameRoom =
      false,
    allowSelf =
      false
  } = {}
) {
  const selectedId =
    getSelectedMemberId(
      interaction.guildId,
      context.channel.id,
      context.room.owner_id
    );

  if (!selectedId) {
    await tempInteractionNotice(
      interaction,
      'Hãy chọn một thành viên ở danh sách bên dưới trước.',
      'warning'
    );

    return null;
  }

  if (
    !allowSelf &&
    String(
      selectedId
    ) ===
    String(
      interaction.user.id
    )
  ) {
    await tempInteractionNotice(
      interaction,
      'Bạn không thể chọn chính mình cho thao tác này.',
      'warning'
    );

    return null;
  }

  const targetMember =
    await fetchMemberSafe(
      interaction.guild,
      selectedId
    );

  if (
    !targetMember ||
    targetMember.user?.bot
  ) {
    clearSelectedMember(
      interaction.guildId,
      context.channel.id,
      context.room.owner_id
    );

    await tempInteractionNotice(
      interaction,
      'Thành viên đã chọn không còn hợp lệ.',
      'warning'
    );

    return null;
  }

  if (
    requireSameRoom &&
    String(
      targetMember.voice?.channelId ||
      ''
    ) !==
    String(
      context.channel.id
    )
  ) {
    await tempInteractionNotice(
      interaction,
      'Thành viên đã chọn hiện không ở trong phòng này.',
      'warning'
    );

    return null;
  }

  return targetMember;
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
      String(
        memberId ||
        ''
      )
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
    return tempInteractionNotice(
      interaction,
      'Không thể sử dụng Bot cho thao tác thành viên.',
      'warning'
    );
  }

  setSelectedMember(
    interaction.guildId,
    context.channel.id,
    context.room.owner_id,
    member.id
  );

  await acknowledgeComponent(
    interaction
  );
}

async function handleRoomLock(
  interaction
) {
  const cooldown =
    useCooldown(
      interaction,
      'room_lock'
    );

  if (cooldown) {
    return tempInteractionNotice(
      interaction,
      'Thao tác hơi nhanh. Hãy thử lại sau một chút.',
      'warning'
    );
  }

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  await acknowledgeComponent(
    interaction
  );

  const locked =
    roomIsLocked(
      context.channel
    );

  const changed =
    await safePermissionEdit(
      context.channel,
      interaction.guild.id,
      {
        Connect:
          locked
            ? null
            : false
      },
      `${BOT_NAME} ${locked ? 'mở' : 'khóa'} phòng`
    );

  if (!changed) {
    return tempFollowUp(
      interaction,
      'Không thể thay đổi trạng thái khóa phòng.',
      'error'
    );
  }

  await ensureOwnerDirectPermissions(
    context.channel,
    context.room.owner_id
  );

  await refreshRoomPanelSafe(
    context.channel.id
  );

  await sendActionLog(
    interaction.guild,
    `${locked ? '🔓' : '🔒'} ${safeMemberName(context.member)} » ${locked ? 'Mở' : 'Khóa'} phòng ${context.channel.name}`
  );

  return tempFollowUp(
    interaction,
    locked
      ? 'Đã mở phòng.'
      : 'Đã khóa phòng.',
    'success'
  );
}

async function handleRoomHide(
  interaction
) {
  const cooldown =
    useCooldown(
      interaction,
      'room_hide'
    );

  if (cooldown) {
    return tempInteractionNotice(
      interaction,
      'Thao tác hơi nhanh. Hãy thử lại sau một chút.',
      'warning'
    );
  }

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  await acknowledgeComponent(
    interaction
  );

  const hidden =
    roomIsHidden(
      context.channel
    );

  const changed =
    await safePermissionEdit(
      context.channel,
      interaction.guild.id,
      {
        ViewChannel:
          hidden
            ? null
            : false
      },
      `${BOT_NAME} ${hidden ? 'hiện' : 'ẩn'} phòng`
    );

  if (!changed) {
    return tempFollowUp(
      interaction,
      'Không thể thay đổi trạng thái hiển thị của phòng.',
      'error'
    );
  }

  await ensureOwnerDirectPermissions(
    context.channel,
    context.room.owner_id
  );

  await refreshRoomPanelSafe(
    context.channel.id
  );

  await sendActionLog(
    interaction.guild,
    `${hidden ? '👁️' : '🙈'} ${safeMemberName(context.member)} » ${hidden ? 'Hiện' : 'Ẩn'} phòng ${context.channel.name}`
  );

  return tempFollowUp(
    interaction,
    hidden
      ? 'Đã hiện phòng.'
      : 'Đã ẩn phòng.',
    'success'
  );
}

function buildRenameModal(
  channel
) {
  const modal =
    new ModalBuilder()
      .setCustomId(
        'room_rename_modal'
      )
      .setTitle(
        'Đổi tên phòng'
      );

  const input =
    new TextInputBuilder()
      .setCustomId(
        'room_new_name'
      )
      .setLabel(
        'Tên phòng mới'
      )
      .setStyle(
        TextInputStyle.Short
      )
      .setPlaceholder(
        'Ví dụ: Gaming'
      )
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(80);

  const currentName =
    cleanRoomName(
      channel?.name
    );

  if (currentName) {
    input.setValue(
      currentName
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

  try {
    await interaction.showModal(
      buildRenameModal(
        context.channel
      )
    );
  } catch (error) {
    logError(
      'ROOM_RENAME_BUTTON',
      error
    );
  }
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

  const cooldown =
    useCooldown(
      interaction,
      'room_rename',
      2500
    );

  if (cooldown) {
    return tempInteractionNotice(
      interaction,
      'Bạn vừa đổi tên phòng. Hãy chờ một chút trước khi đổi tiếp.',
      'warning'
    );
  }

  const rawName =
    interaction.fields.getTextInputValue(
      'room_new_name'
    );

  const cleanName =
    cleanRoomName(
      rawName
    );

  if (!cleanName) {
    return tempReply(
      interaction,
      'Tên phòng không hợp lệ.',
      'warning'
    );
  }

  const newName =
    `${ROOM_PREFIX}${cleanName}`
      .slice(
        0,
        100
      );

  await interaction.deferReply({
    ephemeral:
      true
  });

  const edited =
    await safeEditChannel(
      context.channel,
      {
        name:
          newName
      },
      `${BOT_NAME} đổi tên phòng`
    );

  if (!edited) {
    return tempReply(
      interaction,
      'Không thể đổi tên phòng lúc này.',
      'error'
    );
  }

  await refreshRoomPanelSafe(
    context.channel.id
  );

  await sendActionLog(
    interaction.guild,
    `✏️ ${safeMemberName(context.member)} » Đổi tên phòng thành ${newName}`
  );

  return tempReply(
    interaction,
    `Đã đổi tên phòng thành ${newName}.`,
    'success'
  );
}

function buildLimitModal(
  channel
) {
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
        'room_limit_value'
      )
      .setLabel(
        'Số người tối đa'
      )
      .setStyle(
        TextInputStyle.Short
      )
      .setPlaceholder(
        '0 = Không giới hạn'
      )
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(2);

  input.setValue(
    String(
      channel.userLimit ||
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

  try {
    await interaction.showModal(
      buildLimitModal(
        context.channel
      )
    );
  } catch (error) {
    logError(
      'ROOM_LIMIT_BUTTON',
      error
    );
  }
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

  const rawValue =
    interaction.fields
      .getTextInputValue(
        'room_limit_value'
      )
      .trim();

  if (
    !/^\d{1,2}$/.test(
      rawValue
    )
  ) {
    return tempReply(
      interaction,
      'Giới hạn phải là số từ 0 đến 99.',
      'warning'
    );
  }

  const limit =
    Number(
      rawValue
    );

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
    ephemeral:
      true
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
    return tempReply(
      interaction,
      'Không thể thay đổi giới hạn phòng.',
      'error'
    );
  }

  await refreshRoomPanelSafe(
    context.channel.id
  );

  await sendActionLog(
    interaction.guild,
    `👥 ${safeMemberName(context.member)} » Giới hạn phòng: ${limit === 0 ? 'Không giới hạn' : `${limit} người`}`
  );

  return tempReply(
    interaction,
    limit === 0
      ? 'Đã bỏ giới hạn số người.'
      : `Đã đặt giới hạn ${limit} người.`,
    'success'
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

  const target =
    await getRequiredSelectedMember(
      interaction,
      context,
      {
        requireSameRoom:
          false,
        allowSelf:
          false
      }
    );

  if (!target) {
    return;
  }

  await acknowledgeComponent(
    interaction
  );

  const granted =
    await grantInvitedMemberPermissions(
      context.channel,
      target
    );

  if (!granted) {
    return tempFollowUp(
      interaction,
      'Không thể cấp quyền vào phòng cho thành viên này.',
      'error'
    );
  }

  clearSelectedMember(
    interaction.guildId,
    context.channel.id,
    context.room.owner_id
  );

  await sendActionLog(
    interaction.guild,
    `✉️ ${safeMemberName(context.member)} » Mời ${safeMemberName(target)} vào phòng`
  );

  return tempFollowUp(
    interaction,
    `Đã cấp quyền vào phòng cho ${safeMemberName(target)}.`,
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

  const target =
    await getRequiredSelectedMember(
      interaction,
      context,
      {
        requireSameRoom:
          false,
        allowSelf:
          false
      }
    );

  if (!target) {
    return;
  }

  await acknowledgeComponent(
    interaction
  );

  const denied =
    await denyMemberPermissions(
      context.channel,
      target
    );

  if (!denied) {
    return tempFollowUp(
      interaction,
      'Không thể cấm thành viên này khỏi phòng.',
      'error'
    );
  }

  /*
    Chỉ disconnect nếu target THỰC SỰ
    đang ở chính phòng này.

    Không được đá target khỏi voice channel khác.
  */
  if (
    String(
      target.voice?.channelId ||
      ''
    ) ===
    String(
      context.channel.id
    )
  ) {
    await safeDisconnectMember(
      target,
      context.channel.id,
      `${BOT_NAME} cấm thành viên khỏi phòng`
    );
  }

  clearSelectedMember(
    interaction.guildId,
    context.channel.id,
    context.room.owner_id
  );

  await sendActionLog(
    interaction.guild,
    `⛔ ${safeMemberName(context.member)} » Cấm ${safeMemberName(target)} khỏi phòng`
  );

  return tempFollowUp(
    interaction,
    `Đã cấm ${safeMemberName(target)} khỏi phòng.`,
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

  const target =
    await getRequiredSelectedMember(
      interaction,
      context,
      {
        requireSameRoom:
          true,
        allowSelf:
          false
      }
    );

  if (!target) {
    return;
  }

  await acknowledgeComponent(
    interaction
  );

  /*
    Kiểm tra lần cuối ngay trước khi disconnect
    để tránh race condition khi target vừa
    chuyển sang phòng khác.
  */
  if (
    String(
      target.voice?.channelId ||
      ''
    ) !==
    String(
      context.channel.id
    )
  ) {
    return tempFollowUp(
      interaction,
      'Thành viên đã rời phòng trước khi thao tác hoàn tất.',
      'warning'
    );
  }

  const disconnected =
    await safeDisconnectMember(
      target,
      context.channel.id,
      `${BOT_NAME} đuổi thành viên khỏi phòng`
    );

  if (!disconnected) {
    return tempFollowUp(
      interaction,
      'Không thể đuổi thành viên này khỏi phòng.',
      'error'
    );
  }

  clearSelectedMember(
    interaction.guildId,
    context.channel.id,
    context.room.owner_id
  );

  await sendActionLog(
    interaction.guild,
    `👢 ${safeMemberName(context.member)} » Đuổi ${safeMemberName(target)} khỏi phòng`
  );

  return tempFollowUp(
    interaction,
    `Đã đuổi ${safeMemberName(target)} khỏi phòng.`,
    'success'
  );
}

function buildResetConfirmation() {
  const confirm =
    new ButtonBuilder()
      .setCustomId(
        'room_reset_confirm'
      )
      .setLabel(
        'Xác nhận đặt lại'
      )
      .setEmoji('♻️')
      .setStyle(
        ButtonStyle.Success
      );

  const cancel =
    new ButtonBuilder()
      .setCustomId(
        'room_reset_cancel'
      )
      .setLabel(
        'Hủy'
      )
      .setEmoji('✖️')
      .setStyle(
        ButtonStyle.Primary
      );

  return {
    content: [
      '⚠️ **ĐẶT LẠI PHÒNG?**',
      '',
      'Phòng sẽ trở về:',
      '🔓 Đang mở',
      '👁️ Công khai',
      '👥 Không giới hạn',
      '🌐 Khu vực tự động',
      '🧹 Xóa quyền Mời/Cấm riêng của thành viên',
      '',
      `⏳ Yêu cầu này ${relativeTimestamp(Date.now() + 30_000)}`
    ].join('\n'),

    components: [
      new ActionRowBuilder()
        .addComponents(
          confirm,
          cancel
        )
    ],

    allowedMentions: {
      parse: []
    }
  };
}

async function handleRoomResetButton(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  try {
    await interaction.reply({
      ...buildResetConfirmation(),
      ephemeral:
        true
    });

    deleteInteractionOriginalLater(
      interaction,
      30_000
    );
  } catch (error) {
    logError(
      'ROOM_RESET_CONFIRMATION',
      error
    );
  }
}

async function handleRoomResetConfirm(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  await acknowledgeComponent(
    interaction
  );

  const everyoneChanged =
    await safePermissionEdit(
      context.channel,
      interaction.guild.id,
      {
        ViewChannel:
          null,
        Connect:
          null
      },
      `${BOT_NAME} đặt lại trạng thái phòng`
    );

  if (!everyoneChanged) {
    return tempFollowUp(
      interaction,
      'Không thể đặt lại quyền phòng.',
      'error'
    );
  }

  await clearMemberSpecificOverwrites(
    context.channel,
    [
      context.room.owner_id
    ]
  );

  await ensureOwnerDirectPermissions(
    context.channel,
    context.room.owner_id
  );

  const edited =
    await safeEditChannel(
      context.channel,
      {
        userLimit:
          0,
        rtcRegion:
          null
      },
      `${BOT_NAME} đặt lại phòng`
    );

  if (!edited) {
    /*
      Quyền đã reset nhưng phần userLimit/region
      có thể chưa hoàn tất. Thử region bằng API
      chuyên dụng để tránh bỏ dở im lặng.
    */
    await setVoiceRegionSafe(
      context.channel,
      'automatic'
    );
  }

  await refreshRoomPanelSafe(
    context.channel.id
  );

  await sendActionLog(
    interaction.guild,
    `♻️ ${safeMemberName(context.member)} » Đặt lại phòng ${context.channel.name}`
  );

  try {
    await interaction.editReply({
      content:
        buildNoticeText(
          'Đã đặt lại phòng.',
          'success',
          NOTICE_DELETE_MS
        ),
      components: []
    });

    deleteInteractionOriginalLater(
      interaction,
      NOTICE_DELETE_MS
    );
  } catch (error) {
    await tempFollowUp(
      interaction,
      'Đã đặt lại phòng.',
      'success'
    );
  }
}

async function handleRoomResetCancel(
  interaction
) {
  try {
    await interaction.update({
      content:
        buildNoticeText(
          'Đã hủy đặt lại phòng.',
          'info',
          NOTICE_DELETE_MS
        ),
      components: []
    });

    deleteInteractionOriginalLater(
      interaction,
      NOTICE_DELETE_MS
    );
  } catch (error) {
    logError(
      'ROOM_RESET_CANCEL',
      error
    );
  }
}

async function handleRoomRegionSelect(
  interaction
) {
  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context) {
    return;
  }

  const regionId =
    interaction.values?.[0];

  if (!regionId) {
    return tempInteractionNotice(
      interaction,
      'Khu vực được chọn không hợp lệ.',
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
    await refreshRoomPanelSafe(
      context.channel.id
    );

    return tempFollowUp(
      interaction,
      'Không thể thay đổi khu vực thoại. Danh sách khu vực có thể vừa thay đổi.',
      'error'
    );
  }

  await refreshRoomPanelSafe(
    context.channel.id
  );

  await sendActionLog(
    interaction.guild,
    `🌐 ${safeMemberName(context.member)} » Đổi khu vực: ${result.label}`
  );

  return tempFollowUp(
    interaction,
    `Đã đổi khu vực thành ${result.label}.`,
    'success'
  );
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

  const target =
    await getRequiredSelectedMember(
      interaction,
      context,
      {
        requireSameRoom:
          true,
        allowSelf:
          false
      }
    );

  if (!target) {
    return;
  }

  const absence =
    await getOwnerAbsence(
      context.channel.id
    );

  if (absence) {
    return tempInteractionNotice(
      interaction,
      'Phòng đang trong thời gian bảo lưu chủ phòng. Không thể tạo yêu cầu chuyển chủ mới.',
      'warning'
    );
  }

  const existingTransfer =
    getPendingTransfer(
      context.channel.id
    );

  if (existingTransfer) {
    return tempInteractionNotice(
      interaction,
      'Phòng đang có một yêu cầu chuyển chủ chờ xử lý.',
      'warning'
    );
  }

  const targetOwnedRoom =
    await getOwnedRoom(
      interaction.guildId,
      target.id
    );

  if (
    targetOwnedRoom &&
    String(
      targetOwnedRoom.channel_id
    ) !==
    String(
      context.channel.id
    )
  ) {
    return tempInteractionNotice(
      interaction,
      `${safeMemberName(target)} đang sở hữu một phòng Voice HDK khác.`,
      'warning'
    );
  }

  /*
    Kiểm tra lại target vẫn ở cùng phòng
    ngay trước khi tạo yêu cầu.
  */
  if (
    String(
      target.voice?.channelId ||
      ''
    ) !==
    String(
      context.channel.id
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Thành viên đã chọn không còn ở trong phòng.',
      'warning'
    );
  }

  await acknowledgeComponent(
    interaction
  );

  try {
    await createTransferRequest(
      interaction,
      context,
      target
    );

    /*
      Theo yêu cầu:
      clear selection ngay sau khi gửi
      yêu cầu chuyển chủ.
    */
    clearSelectedMember(
      interaction.guildId,
      context.channel.id,
      context.room.owner_id
    );
  } catch (error) {
    logError(
      'ROOM_TRANSFER_BUTTON',
      error
    );

    await tempFollowUp(
      interaction,
      'Không thể tạo yêu cầu chuyển chủ lúc này.',
      'error'
    );
  }
}
function actionActorName(
  member
) {
  return safeMemberName(
    member
  );
}

async function getActionLogChannel(
  guild
) {
  if (!guild) {
    return null;
  }

  const generator =
    await getGenerator(
      guild.id
    );

  if (!generator) {
    return null;
  }

  let channel =
    await fetchChannelSafe(
      guild,
      generator.action_log_channel_id
    );

  if (
    isGuildTextChannel(
      channel
    )
  ) {
    return channel;
  }

  const ensured =
    await ensureManagedLogChannels(
      guild,
      generator
    ).catch(
      error => {
        logError(
          'ENSURE_ACTION_LOG',
          error
        );

        return null;
      }
    );

  return (
    ensured?.actionLog ||
    null
  );
}

async function sendActionLog(
  guild,
  content
) {
  if (!guild) {
    return null;
  }

  const channel =
    await getActionLogChannel(
      guild
    );

  if (!channel) {
    return null;
  }

  const clean =
    String(
      content ||
      ''
    )
      .replace(
        /\r?\n/g,
        ' '
      )
      .trim()
      .slice(
        0,
        1800
      );

  if (!clean) {
    return null;
  }

  try {
    return await channel.send({
      content:
        `${clean} • ${vietnamTime()}`,
      allowedMentions: {
        parse: []
      }
    });
  } catch (error) {
    logError(
      'SEND_ACTION_LOG',
      error
    );

    return null;
  }
}

function buildTransferRequestPayload(
  owner,
  target,
  expiresAt
) {
  const accept =
    new ButtonBuilder()
      .setCustomId(
        'transfer_accept'
      )
      .setLabel(
        'Đồng ý'
      )
      .setEmoji('👑')
      .setStyle(
        ButtonStyle.Success
      );

  const decline =
    new ButtonBuilder()
      .setCustomId(
        'transfer_decline'
      )
      .setLabel(
        'Từ chối'
      )
      .setEmoji('✖️')
      .setStyle(
        ButtonStyle.Primary
      );

  return {
    content: [
      `👑 ${safeMemberName(owner)} muốn chuyển quyền chủ phòng cho <@${target.id}>`,
      '',
      `⏳ Hết hạn ${relativeTimestamp(expiresAt)}`
    ].join('\n'),

    components: [
      new ActionRowBuilder()
        .addComponents(
          accept,
          decline
        )
    ],

    allowedMentions: {
      users: [
        target.id
      ],
      roles: [],
      repliedUser:
        false
    }
  };
}

async function editTransferResult(
  transfer,
  content,
  type =
    'info'
) {
  if (!transfer) {
    return;
  }

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
      transfer.channelId
    );

  if (
    !channel?.isTextBased?.()
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
        buildNoticeText(
          content,
          type,
          NOTICE_DELETE_MS
        ),
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
    if (
      !isUnknownDiscordResource(
        error
      )
    ) {
      logError(
        'EDIT_TRANSFER_RESULT',
        error
      );
    }
  }
}

async function expireTransferRequest(
  channelId
) {
  const transfer =
    getPendingTransfer(
      channelId
    );

  if (!transfer) {
    pendingTransfers.delete(
      transferKey(
        channelId
      )
    );

    return;
  }

  if (
    transfer.expiresAt >
    Date.now()
  ) {
    return;
  }

  clearPendingTransfer(
    channelId
  );

  await editTransferResult(
    transfer,
    'Yêu cầu chuyển chủ đã hết hạn.',
    'warning'
  );
}

async function createTransferRequest(
  interaction,
  context,
  target
) {
  const channel =
    context.channel;

  const owner =
    context.member;

  if (
    String(
      target.voice?.channelId ||
      ''
    ) !==
    String(
      channel.id
    )
  ) {
    throw new Error(
      'TARGET_NOT_IN_ROOM'
    );
  }

  const expiresAt =
    Date.now() +
    TRANSFER_TIMEOUT_MS;

  const message =
    await channel.send(
      buildTransferRequestPayload(
        owner,
        target,
        expiresAt
      )
    );

  const timer =
    setTimeout(
      () => {
        expireTransferRequest(
          channel.id
        ).catch(
          error => {
            logError(
              'TRANSFER_TIMEOUT',
              error
            );
          }
        );
      },
      TRANSFER_TIMEOUT_MS +
        250
    );

  timer.unref?.();

  setPendingTransfer(
    channel.id,
    {
      guildId:
        interaction.guildId,

      channelId:
        channel.id,

      messageId:
        message.id,

      ownerId:
        context.room.owner_id,

      targetId:
        target.id,

      expiresAt,

      timer
    }
  );

  return message;
}

async function handleTransferAccept(
  interaction
) {
  if (
    !interaction.inGuild()
  ) {
    return tempInteractionNotice(
      interaction,
      'Yêu cầu này không còn hợp lệ.',
      'warning'
    );
  }

  const channel =
    interaction.channel;

  if (
    !isVoiceChannel(
      channel
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Phòng chuyển chủ không còn hợp lệ.',
      'warning'
    );
  }

  const transfer =
    getPendingTransfer(
      channel.id
    );

  if (!transfer) {
    return tempInteractionNotice(
      interaction,
      'Yêu cầu chuyển chủ đã hết hạn hoặc đã được xử lý.',
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
      'Chỉ thành viên được chọn mới có thể đồng ý yêu cầu này.',
      'warning'
    );
  }

  if (
    transfer.expiresAt <=
    Date.now()
  ) {
    clearPendingTransfer(
      channel.id
    );

    await editTransferResult(
      transfer,
      'Yêu cầu chuyển chủ đã hết hạn.',
      'warning'
    );

    return;
  }

  const room =
    await getRoom(
      channel.id
    );

  if (
    !room ||
    String(
      room.owner_id
    ) !==
    String(
      transfer.ownerId
    )
  ) {
    clearPendingTransfer(
      channel.id
    );

    await editTransferResult(
      transfer,
      'Yêu cầu chuyển chủ không còn hợp lệ vì chủ phòng đã thay đổi.',
      'warning'
    );

    return;
  }

  const oldOwner =
    await fetchMemberSafe(
      interaction.guild,
      transfer.ownerId
    );

  const newOwner =
    await fetchMemberSafe(
      interaction.guild,
      transfer.targetId
    );

  if (
    !newOwner ||
    newOwner.user?.bot
  ) {
    clearPendingTransfer(
      channel.id
    );

    await editTransferResult(
      transfer,
      'Không thể xác minh chủ phòng mới.',
      'error'
    );

    return;
  }

  if (
    String(
      newOwner.voice?.channelId ||
      ''
    ) !==
    String(
      channel.id
    )
  ) {
    return tempInteractionNotice(
      interaction,
      'Bạn phải còn ở trong phòng để nhận quyền chủ phòng.',
      'warning'
    );
  }

  const otherOwnedRoom =
    await getOwnedRoom(
      interaction.guildId,
      newOwner.id
    );

  if (
    otherOwnedRoom &&
    String(
      otherOwnedRoom.channel_id
    ) !==
    String(
      channel.id
    )
  ) {
    clearPendingTransfer(
      channel.id
    );

    await editTransferResult(
      transfer,
      `${safeMemberName(newOwner)} đang sở hữu một phòng Voice HDK khác.`,
      'warning'
    );

    return;
  }

  await acknowledgeComponent(
    interaction
  );

  const dbClient =
    await pool.connect();

  let databaseChanged =
    false;

  try {
    await dbClient.query(
      'BEGIN'
    );

    const lockedRoom =
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

    const currentRoom =
      lockedRoom.rows[0];

    if (
      !currentRoom ||
      String(
        currentRoom.owner_id
      ) !==
      String(
        transfer.ownerId
      )
    ) {
      throw new Error(
        'OWNER_CHANGED_DURING_TRANSFER'
      );
    }

    const conflict =
      await dbClient.query(
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
          interaction.guildId,
          newOwner.id,
          channel.id
        ]
      );

    if (
      conflict.rowCount >
      0
    ) {
      throw new Error(
        'TARGET_ALREADY_OWNS_ROOM'
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

    databaseChanged =
      true;
  } catch (error) {
    await dbClient.query(
      'ROLLBACK'
    ).catch(
      () => {}
    );

    dbClient.release();

    if (
      error?.message ===
      'TARGET_ALREADY_OWNS_ROOM'
    ) {
      clearPendingTransfer(
        channel.id
      );

      await editTransferResult(
        transfer,
        `${safeMemberName(newOwner)} đang sở hữu một phòng Voice HDK khác.`,
        'warning'
      );

      return;
    }

    if (
      error?.message ===
      'OWNER_CHANGED_DURING_TRANSFER'
    ) {
      clearPendingTransfer(
        channel.id
      );

      await editTransferResult(
        transfer,
        'Yêu cầu không còn hợp lệ vì chủ phòng đã thay đổi.',
        'warning'
      );

      return;
    }

    logError(
      'TRANSFER_DB',
      error
    );

    clearPendingTransfer(
      channel.id
    );

    await editTransferResult(
      transfer,
      'Không thể hoàn tất chuyển chủ.',
      'error'
    );

    return;
  }

  if (
    databaseChanged
  ) {
    dbClient.release();
  }

  const newOwnerGranted =
    await grantRoomOwnerPermissions(
      channel,
      newOwner
    );

  if (!newOwnerGranted) {
    try {
      await updateRoomOwner(
        channel.id,
        transfer.ownerId
      );
    } catch (rollbackError) {
      logError(
        'TRANSFER_PERMISSION_DB_ROLLBACK',
        rollbackError
      );
    }

    clearPendingTransfer(
      channel.id
    );

    await refreshRoomPanelSafe(
      channel.id
    ).catch(
      () => {}
    );

    await editTransferResult(
      transfer,
      'Không thể cấp quyền cho chủ phòng mới nên việc chuyển chủ đã được hủy.',
      'error'
    );

    return;
  }

  if (
    oldOwner &&
    String(
      oldOwner.id
    ) !==
    String(
      newOwner.id
    )
  ) {
    await revokeOldOwnerPermissions(
      channel,
      oldOwner.id
    );
  } else if (
    transfer.ownerId !==
    newOwner.id
  ) {
    await revokeOldOwnerPermissions(
      channel,
      transfer.ownerId
    );
  }

  clearPendingTransfer(
    channel.id
  );

  await deleteOwnerAbsence(
    channel.id
  ).catch(
    () => {}
  );

  clearRuntimeOwnerAbsenceTimer(
    channel.id
  );

  clearSelectedMember(
    interaction.guildId,
    channel.id,
    transfer.ownerId
  );

  await refreshRoomPanelSafe(
    channel.id
  );

  await sendActionLog(
    interaction.guild,
    `👑 ${oldOwner ? safeMemberName(oldOwner) : 'Chủ phòng cũ'} » Chuyển chủ cho ${safeMemberName(newOwner)}`
  );

  await editTransferResult(
    transfer,
    `${safeMemberName(newOwner)} đã trở thành chủ phòng mới.`,
    'success'
  );
}

async function handleTransferDecline(
  interaction
) {
  if (
    !interaction.inGuild()
  ) {
    return;
  }

  const channel =
    interaction.channel;

  if (
    !isVoiceChannel(
      channel
    )
  ) {
    return;
  }

  const transfer =
    getPendingTransfer(
      channel.id
    );

  if (!transfer) {
    return tempInteractionNotice(
      interaction,
      'Yêu cầu chuyển chủ đã hết hạn hoặc đã được xử lý.',
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
      'Chỉ thành viên được chọn mới có thể từ chối yêu cầu này.',
      'warning'
    );
  }

  await acknowledgeComponent(
    interaction
  );

  clearPendingTransfer(
    channel.id
  );

  await editTransferResult(
    transfer,
    'Yêu cầu chuyển chủ đã bị từ chối.',
    'info'
  );
}

function compactLogText(
  value,
  maxLength =
    1000
) {
  const clean =
    String(
      value ||
      ''
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
    clean.length <=
    maxLength
  ) {
    return clean;
  }

  return (
    clean.slice(
      0,
      Math.max(
        0,
        maxLength -
        1
      )
    ) +
    '…'
  );
}

function escapeLogQuote(
  value
) {
  return compactLogText(
    value,
    1200
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
  text
) {
  const source =
    String(
      text ||
      ''
    );

  const matches =
    source.match(
      /https?:\/\/[^\s<>"']+/gi
    ) ||
    [];

  return [
    ...new Set(
      matches
    )
  ].slice(
    0,
    10
  );
}

function attachmentSummary(
  attachments
) {
  if (
    !attachments ||
    attachments.size ===
      0
  ) {
    return '';
  }

  return [
    ...attachments.values()
  ]
    .map(
      attachment =>
        compactLogText(
          attachment.name ||
          'tệp-không-tên',
          100
        )
    )
    .join(
      ' • '
    )
    .slice(
      0,
      1000
    );
}

async function getChatLogChannel(
  guild
) {
  if (!guild) {
    return null;
  }

  const generator =
    await getGenerator(
      guild.id
    );

  if (!generator) {
    return null;
  }

  let channel =
    await fetchChannelSafe(
      guild,
      generator.chat_log_channel_id
    );

  if (
    isGuildTextChannel(
      channel
    )
  ) {
    return channel;
  }

  const ensured =
    await ensureManagedLogChannels(
      guild,
      generator
    ).catch(
      error => {
        logError(
          'ENSURE_CHAT_LOG',
          error
        );

        return null;
      }
    );

  return (
    ensured?.chatLog ||
    null
  );
}

function estimatedDiscordUploadLimit(
  guild
) {
  const premiumTier =
    Number(
      guild?.premiumTier ||
      0
    );

  if (
    premiumTier >=
    3
  ) {
    return (
      100 *
      1024 *
      1024
    );
  }

  if (
    premiumTier >=
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
  url,
  maxBytes
) {
  if (
    !url ||
    typeof fetch !==
      'function'
  ) {
    throw new Error(
      'ATTACHMENT_DOWNLOAD_UNAVAILABLE'
    );
  }

  const response =
    await fetch(
      url,
      {
        signal:
          AbortSignal.timeout(
            15000
          )
      }
    );

  if (
    !response.ok
  ) {
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
    contentLength >
    maxBytes
  ) {
    throw new Error(
      'ATTACHMENT_TOO_LARGE'
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  if (
    arrayBuffer.byteLength >
    maxBytes
  ) {
    throw new Error(
      'ATTACHMENT_TOO_LARGE'
    );
  }

  return Buffer.from(
    arrayBuffer
  );
}

async function archiveAttachments(
  message,
  logChannel
) {
  if (
    !message?.attachments ||
    message.attachments.size ===
      0 ||
    !logChannel
  ) {
    return [];
  }

  const maxUpload =
    estimatedDiscordUploadLimit(
      message.guild
    );

  const results = [];

  for (
    const attachment
    of message.attachments.values()
  ) {
    const name =
      compactLogText(
        attachment.name ||
        'tep-dinh-kem',
        100
      );

    const size =
      Number(
        attachment.size ||
        0
      );

    if (
      size >
      maxUpload
    ) {
      results.push({
        name,
        archived:
          false,
        url:
          attachment.url,
        warning:
          'Tệp vượt giới hạn lưu trữ.'
      });

      continue;
    }

    try {
      const buffer =
        await downloadAttachmentBuffer(
          attachment.url,
          maxUpload
        );

      const archiveMessage =
        await logChannel.send({
          content:
            `📦 Lưu tệp từ ${safeMemberName(message.member)} • ${vietnamTime()}`,

          files: [
            {
              attachment:
                buffer,
              name
            }
          ],

          allowedMentions: {
            parse: []
          }
        });

      const archivedAttachment =
        archiveMessage
          .attachments
          .first();

      results.push({
        name,
        archived:
          true,
        url:
          archivedAttachment?.url ||
          null,
        warning:
          null
      });
    } catch (error) {
      logError(
        'ARCHIVE_ATTACHMENT',
        error
      );

      results.push({
        name,
        archived:
          false,
        url:
          attachment.url,
        warning:
          'Không thể sao lưu tệp; đã giữ liên kết gốc.'
      });
    }
  }

  return results;
}

function messageAuthorName(
  message
) {
  if (
    message?.member
  ) {
    return safeMemberName(
      message.member
    );
  }

  return cleanDisplayName(
    message?.author?.globalName ||
    message?.author?.username ||
    'Không xác định'
  );
}

function buildAttachmentLogLines(
  archived
) {
  if (
    !Array.isArray(
      archived
    ) ||
    archived.length ===
      0
  ) {
    return [];
  }

  const lines = [];

  const names =
    archived
      .map(
        item =>
          item.name
      )
      .filter(Boolean)
      .join(
        ' • '
      );

  if (names) {
    lines.push(
      `📎 Tệp đính kèm: ${names}`
    );
  }

  for (
    const item
    of archived
  ) {
    if (
      item.archived &&
      item.url
    ) {
      lines.push(
        `📦 Bản lưu: ${item.url}`
      );
    } else if (
      item.url
    ) {
      lines.push(
        `🔗 Tệp gốc: ${item.url}`
      );
    }

    if (
      item.warning
    ) {
      lines.push(
        `⚠️ ${item.name}: ${item.warning}`
      );
    }
  }

  return lines;
}

async function sendChatCreateLog(
  message
) {
  if (
    !message?.guild ||
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

  const author =
    messageAuthorName(
      message
    );

  const content =
    escapeLogQuote(
      message.content
    );

  const urls =
    extractUrls(
      message.content
    );

  const archived =
    await archiveAttachments(
      message,
      logChannel
    );

  const lines = [];

  if (content) {
    lines.push(
      `💬 ${author} » "${content}"`
    );
  } else {
    lines.push(
      `💬 ${author} » Tin nhắn không có nội dung chữ`
    );
  }

  if (
    urls.length >
    0
  ) {
    lines.push(
      `🔗 Liên kết: ${urls.join(' • ')}`
    );
  }

  lines.push(
    ...buildAttachmentLogLines(
      archived
    )
  );

  lines.push(
    vietnamTime(
      message.createdAt ||
      new Date()
    )
  );

  try {
    await logChannel.send({
      content:
        lines
          .join('\n')
          .slice(
            0,
            2000
          ),

      allowedMentions: {
        parse: []
      }
    });
  } catch (error) {
    logError(
      'CHAT_CREATE_LOG',
      error
    );
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
  } catch (error) {
    return message;
  }
}

async function sendChatEditLog(
  oldMessage,
  newMessage
) {
  const oldHydrated =
    await hydratePartialMessage(
      oldMessage
    );

  const newHydrated =
    await hydratePartialMessage(
      newMessage
    );

  const message =
    newHydrated ||
    oldHydrated;

  if (
    !message?.guild ||
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

  const before =
    escapeLogQuote(
      oldHydrated?.content
    );

  const after =
    escapeLogQuote(
      newHydrated?.content
    );

  if (
    before ===
    after
  ) {
    return;
  }

  const author =
    messageAuthorName(
      message
    );

  const lines = [
    `✏️ ${author} » Đã sửa tin nhắn`,
    `↩️ Trước: "${before || '(trống)'}"`,
    `↪️ Sau: "${after || '(trống)'}"`,
    vietnamTime()
  ];

  try {
    await logChannel.send({
      content:
        lines
          .join('\n')
          .slice(
            0,
            2000
          ),

      allowedMentions: {
        parse: []
      }
    });
  } catch (error) {
    logError(
      'CHAT_EDIT_LOG',
      error
    );
  }
}

async function sendChatDeleteLog(
  message
) {
  if (
    !message?.guild ||
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

  const author =
    messageAuthorName(
      message
    );

  const content =
    escapeLogQuote(
      message.content
    );

  const files =
    attachmentSummary(
      message.attachments
    );

  const urls =
    extractUrls(
      message.content
    );

  const lines = [
    `🗑️ ${author} » Đã xóa tin nhắn`,
    `💬 Nội dung: "${content || '(không có nội dung chữ)'}"`
  ];

  if (
    urls.length >
    0
  ) {
    lines.push(
      `🔗 Liên kết: ${urls.join(' • ')}`
    );
  }

  if (files) {
    lines.push(
      `📎 Tệp: ${files}`
    );
  }

  lines.push(
    vietnamTime()
  );

  try {
    await logChannel.send({
      content:
        lines
          .join('\n')
          .slice(
            0,
            2000
          ),

      allowedMentions: {
        parse: []
      }
    });
  } catch (error) {
    logError(
      'CHAT_DELETE_LOG',
      error
    );
  }
}

async function sendBulkDeleteLog(
  messages
) {
  if (
    !messages ||
    messages.size ===
      0
  ) {
    return;
  }

  const first =
    messages.first();

  if (
    !first?.guild
  ) {
    return;
  }

  const logChannel =
    await getChatLogChannel(
      first.guild
    );

  if (!logChannel) {
    return;
  }

  const validMessages =
    [
      ...messages.values()
    ].filter(
      message =>
        !message.author?.bot &&
        String(
          message.channelId
        ) !==
        String(
          logChannel.id
        )
    );

  if (
    validMessages.length ===
    0
  ) {
    return;
  }

  const lines = [
    `🧹 Voice HDK » ${validMessages.length} tin nhắn vừa bị xóa hàng loạt`
  ];

  for (
    const message
    of validMessages.slice(
      0,
      15
    )
  ) {
    const author =
      messageAuthorName(
        message
      );

    const content =
      compactLogText(
        message.content ||
        '(không có nội dung chữ)',
        120
      );

    lines.push(
      `• ${author}: "${content}"`
    );
  }

  if (
    validMessages.length >
    15
  ) {
    lines.push(
      `• … và ${validMessages.length - 15} tin nhắn khác`
    );
  }

  lines.push(
    vietnamTime()
  );

  try {
    await logChannel.send({
      content:
        lines
          .join('\n')
          .slice(
            0,
            2000
          ),

      allowedMentions: {
        parse: []
      }
    });
  } catch (error) {
    logError(
      'BULK_DELETE_LOG',
      error
    );
  }
}
async function deleteOwnerAbsenceNotice(
  channel,
  absence
) {
  if (
    !channel?.isTextBased?.() ||
    !absence?.notice_message_id
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
  channelId,
  {
    ownerReturned = false,
    member = null
  } = {}
) {
  clearRuntimeOwnerAbsenceTimer(
    channelId
  );

  const absence =
    await getOwnerAbsence(
      channelId
    );

  if (!absence) {
    return false;
  }

  const guild =
    client.guilds.cache.get(
      String(
        absence.guild_id
      )
    );

  const channel =
    guild
      ? await fetchChannelSafe(
          guild,
          channelId
        )
      : null;

  if (channel) {
    await deleteOwnerAbsenceNotice(
      channel,
      absence
    );
  }

  await deleteOwnerAbsence(
    channelId
  );

  if (
    ownerReturned &&
    channel
  ) {
    const ownerName =
      member
        ? safeMemberName(
            member
          )
        : 'Chủ phòng';

    await sendTemporaryChannelNotice(
      channel,
      `${ownerName} đã quay lại. Quyền chủ phòng được giữ nguyên.`,
      'success',
      NOTICE_DELETE_MS
    );
  }

  return true;
}

async function sendOwnerAbsenceNotice(
  channel,
  owner,
  deadlineAt
) {
  if (
    !channel?.isTextBased?.()
  ) {
    return null;
  }

  const ownerName =
    owner
      ? safeMemberName(
          owner
        )
      : 'Chủ phòng';

  try {
    return await channel.send({
      content: [
        `👑 ${ownerName} đã rời phòng.`,
        '',
        'Quyền chủ phòng đang được bảo lưu.',
        `Nếu chủ phòng không quay lại, hệ thống sẽ tự chuyển chủ ${relativeTimestamp(deadlineAt)}.`,
        '',
        '🟠 Người đã ở trong phòng lâu nhất sẽ được ưu tiên nhận quyền chủ.'
      ].join('\n'),

      allowedMentions: {
        parse: []
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

function scheduleOwnerAbsenceTimer(
  channelId,
  deadlineAt
) {
  clearRuntimeOwnerAbsenceTimer(
    channelId
  );

  const remaining =
    Math.max(
      250,
      new Date(
        deadlineAt
      ).getTime() -
      Date.now()
    );

  const delay =
    Math.min(
      remaining,
      2_147_000_000
    );

  const timer =
    setTimeout(
      async () => {
        ownerAbsenceTimers.delete(
          String(
            channelId
          )
        );

        try {
          await processOwnerAbsenceExpiry(
            channelId
          );
        } catch (error) {
          logError(
            'OWNER_ABSENCE_EXPIRY',
            error
          );
        }
      },
      delay
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
  room,
  channel,
  owner
) {
  if (
    !room ||
    !isVoiceChannel(
      channel
    )
  ) {
    return;
  }

  /*
    Kiểm tra trạng thái thực tế lần cuối.
    Điều này đặc biệt quan trọng khi chủ phòng
    vừa nhảy vào ➕ Tạo phòng và bot đã kéo
    họ ngược về phòng cũ.
  */
  const freshOwner =
    owner ||
    await fetchMemberSafe(
      channel.guild,
      room.owner_id
    );

  if (
    freshOwner &&
    String(
      freshOwner.voice?.channelId ||
      ''
    ) ===
    String(
      channel.id
    )
  ) {
    await cancelOwnerAbsence(
      channel.id
    ).catch(
      () => {}
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
    scheduleEmptyRoomCheck(
      channel.id
    );

    return;
  }

  const existing =
    await getOwnerAbsence(
      channel.id
    );

  if (existing) {
    scheduleOwnerAbsenceTimer(
      channel.id,
      existing.deadline_at
    );

    return;
  }

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

      deadlineAt,

      noticeMessageId:
        null
    });

  const notice =
    await sendOwnerAbsenceNotice(
      channel,
      freshOwner,
      deadlineAt
    );

  if (
    notice?.id
  ) {
    await setOwnerAbsenceNotice(
      channel.id,
      notice.id
    );

    absence.notice_message_id =
      notice.id;
  }

  scheduleOwnerAbsenceTimer(
    channel.id,
    deadlineAt
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
  room,
  channel
) {
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
    return null;
  }

  const humanMap =
    new Map(
      humans.map(
        member => [
          String(
            member.id
          ),
          member
        ]
      )
    );

  const presence =
    await getRoomPresence(
      channel.id
    );

  for (
    const row
    of presence
  ) {
    const member =
      humanMap.get(
        String(
          row.member_id
        )
      );

    if (
      !member ||
      member.user?.bot
    ) {
      continue;
    }

    if (
      String(
        member.id
      ) ===
      String(
        room.owner_id
      )
    ) {
      continue;
    }

    const ownsOther =
      await memberOwnsOtherRoom(
        channel.guild.id,
        member.id,
        channel.id
      );

    if (!ownsOther) {
      return member;
    }
  }

  /*
    Fallback cho trường hợp presence vừa được
    phục hồi sau restart.
  */
  for (
    const member
    of humans
  ) {
    if (
      String(
        member.id
      ) ===
      String(
        room.owner_id
      )
    ) {
      continue;
    }

    const ownsOther =
      await memberOwnsOtherRoom(
        channel.guild.id,
        member.id,
        channel.id
      );

    if (!ownsOther) {
      return member;
    }
  }

  return null;
}

async function applyAutomaticOwnershipTransfer(
  room,
  channel,
  newOwner
) {
  if (
    !room ||
    !channel ||
    !newOwner
  ) {
    return false;
  }

  return withRoomLifecycleLock(
    channel.id,
    async () => {
      const freshRoom =
        await getRoom(
          channel.id
        );

      if (!freshRoom) {
        return false;
      }

      const absence =
        await getOwnerAbsence(
          channel.id
        );

      if (!absence) {
        return false;
      }

      if (
        String(
          freshRoom.owner_id
        ) !==
        String(
          absence.owner_id
        )
      ) {
        await cancelOwnerAbsence(
          channel.id
        );

        return false;
      }

      const freshOwner =
        await fetchMemberSafe(
          channel.guild,
          freshRoom.owner_id
        );

      /*
        Chủ cũ đã quay lại đúng phòng:
        tuyệt đối không chuyển chủ.
      */
      if (
        freshOwner &&
        String(
          freshOwner.voice?.channelId ||
          ''
        ) ===
        String(
          channel.id
        )
      ) {
        await cancelOwnerAbsence(
          channel.id,
          {
            ownerReturned:
              true,
            member:
              freshOwner
          }
        );

        return false;
      }

      const target =
        await fetchMemberSafe(
          channel.guild,
          newOwner.id
        );

      if (
        !target ||
        target.user?.bot ||
        String(
          target.voice?.channelId ||
          ''
        ) !==
        String(
          channel.id
        )
      ) {
        return false;
      }

      if (
        await memberOwnsOtherRoom(
          channel.guild.id,
          target.id,
          channel.id
        )
      ) {
        return false;
      }

      const dbClient =
        await pool.connect();

      try {
        await dbClient.query(
          'BEGIN'
        );

        const lockedRoom =
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

        const current =
          lockedRoom.rows[0];

        if (
          !current ||
          String(
            current.owner_id
          ) !==
          String(
            freshRoom.owner_id
          )
        ) {
          throw new Error(
            'AUTO_TRANSFER_OWNER_CHANGED'
          );
        }

        const conflict =
          await dbClient.query(
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
              channel.guild.id,
              target.id,
              channel.id
            ]
          );

        if (
          conflict.rowCount >
          0
        ) {
          throw new Error(
            'AUTO_TRANSFER_TARGET_CONFLICT'
          );
        }

        await updateRoomOwner(
          channel.id,
          target.id,
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

        if (
          error?.message !==
            'AUTO_TRANSFER_TARGET_CONFLICT' &&
          error?.message !==
            'AUTO_TRANSFER_OWNER_CHANGED'
        ) {
          logError(
            'AUTO_TRANSFER_DB',
            error
          );
        }

        return false;
      } finally {
        dbClient.release();
      }

      const granted =
        await grantRoomOwnerPermissions(
          channel,
          target
        );

      if (!granted) {
        /*
          Discord permission thất bại:
          cố khôi phục DB về chủ cũ.
        */
        try {
          await updateRoomOwner(
            channel.id,
            freshRoom.owner_id
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
              freshRoom.owner_id,
            deadlineAt:
              retryDeadline,
            noticeMessageId:
              absence.notice_message_id ||
              null
          });

          scheduleOwnerAbsenceTimer(
            channel.id,
            retryDeadline
          );
        } catch (rollbackError) {
          logError(
            'AUTO_TRANSFER_ROLLBACK',
            rollbackError
          );
        }

        return false;
      }

      await revokeOldOwnerPermissions(
        channel,
        freshRoom.owner_id
      );

      clearRuntimeOwnerAbsenceTimer(
        channel.id
      );

      clearPendingTransfer(
        channel.id
      );

      clearSelectedMember(
        channel.guild.id,
        channel.id,
        freshRoom.owner_id
      );

      await deleteOwnerAbsenceNotice(
        channel,
        absence
      );

      await refreshRoomPanelSafe(
        channel.id
      );

      const oldOwnerName =
        freshOwner
          ? safeMemberName(
              freshOwner
            )
          : 'Chủ phòng cũ';

      await sendActionLog(
        channel.guild,
        `👑 Voice HDK » Tự chuyển chủ từ ${oldOwnerName} cho ${safeMemberName(target)}`
      );

      await sendTemporaryChannelNotice(
        channel,
        `${safeMemberName(target)} đã trở thành chủ phòng mới.`,
        'success',
        NOTICE_DELETE_MS
      );

      return true;
    }
  );
}

async function processOwnerAbsenceExpiry(
  channelId
) {
  const absence =
    await getOwnerAbsence(
      channelId
    );

  if (!absence) {
    clearRuntimeOwnerAbsenceTimer(
      channelId
    );

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
    scheduleOwnerAbsenceTimer(
      channelId,
      absence.deadline_at
    );

    return;
  }

  const guild =
    client.guilds.cache.get(
      String(
        absence.guild_id
      )
    );

  if (!guild) {
    scheduleOwnerAbsenceTimer(
      channelId,
      new Date(
        Date.now() +
        AUTO_TRANSFER_RETRY_MS
      )
    );

    return;
  }

  const channel =
    await fetchChannelSafe(
      guild,
      channelId
    );

  const room =
    await getRoom(
      channelId
    );

  if (
    !room ||
    !isVoiceChannel(
      channel
    )
  ) {
    await deleteOwnerAbsence(
      channelId
    );

    clearRuntimeOwnerAbsenceTimer(
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
    await cancelOwnerAbsence(
      channelId
    );

    scheduleEmptyRoomCheck(
      channelId
    );

    return;
  }

  const owner =
    await fetchMemberSafe(
      guild,
      room.owner_id
    );

  if (
    owner &&
    String(
      owner.voice?.channelId ||
      ''
    ) ===
    String(
      channel.id
    )
  ) {
    await cancelOwnerAbsence(
      channel.id,
      {
        ownerReturned:
          true,
        member:
          owner
      }
    );

    return;
  }

  const candidate =
    await chooseAutomaticOwner(
      room,
      channel
    );

  if (candidate) {
    const transferred =
      await applyAutomaticOwnershipTransfer(
        room,
        channel,
        candidate
      );

    if (transferred) {
      return;
    }
  }

  /*
    Chưa có người đủ điều kiện:
    giữ trạng thái bảo lưu và thử lại sau.
  */
  const retryDeadline =
    new Date(
      Date.now() +
      AUTO_TRANSFER_RETRY_MS
    );

  await deleteOwnerAbsenceNotice(
    channel,
    absence
  );

  await saveOwnerAbsence({
    guildId:
      guild.id,
    channelId:
      channel.id,
    ownerId:
      room.owner_id,
    deadlineAt:
      retryDeadline,
    noticeMessageId:
      null
  });

  const notice =
    await channel.send({
      content: [
        '🟠 Chưa có thành viên đủ điều kiện nhận quyền chủ phòng.',
        `Hệ thống sẽ kiểm tra lại ${relativeTimestamp(retryDeadline)}.`
      ].join('\n'),
      allowedMentions: {
        parse: []
      }
    }).catch(
      error => {
        logError(
          'AUTO_TRANSFER_RETRY_NOTICE',
          error
        );

        return null;
      }
    );

  if (
    notice?.id
  ) {
    await setOwnerAbsenceNotice(
      channel.id,
      notice.id
    );
  }

  scheduleOwnerAbsenceTimer(
    channel.id,
    retryDeadline
  );
}

async function handleActualOwnerState(
  guild,
  oldChannelId,
  member
) {
  if (
    !guild ||
    !member ||
    member.user?.bot
  ) {
    return;
  }

  /*
    Dùng voice state THỰC TẾ sau khi generator
    đã xử lý xong, thay vì newState cũ.

    Nhờ vậy chủ phòng nhảy vào ➕ Tạo phòng
    rồi bị bot đưa về phòng cũ sẽ không bị
    tính nhầm là đã rời phòng.
  */
  const actualChannelId =
    member.voice?.channelId ||
    null;

  if (oldChannelId) {
    const oldRoom =
      await getRoom(
        oldChannelId
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
      if (
        String(
          actualChannelId ||
          ''
        ) ===
        String(
          oldChannelId
        )
      ) {
        await cancelOwnerAbsence(
          oldChannelId
        ).catch(
          () => {}
        );
      } else {
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
          const humans =
            humanMembers(
              oldChannel
            );

          if (
            humans.length >
            0
          ) {
            await beginOwnerAbsence(
              oldRoom,
              oldChannel,
              member
            );
          } else {
            await cancelOwnerAbsence(
              oldChannelId
            ).catch(
              () => {}
            );

            scheduleEmptyRoomCheck(
              oldChannelId
            );
          }
        }
      }
    }
  }

  if (actualChannelId) {
    const actualRoom =
      await getRoom(
        actualChannelId
      );

    if (
      actualRoom &&
      String(
        actualRoom.owner_id
      ) ===
      String(
        member.id
      )
    ) {
      await cancelOwnerAbsence(
        actualChannelId,
        {
          ownerReturned:
            true,
          member
        }
      ).catch(
        error => {
          logError(
            'OWNER_RETURN_CANCEL',
            error
          );
        }
      );
    }
  }
}

const slashCommands = [
  new SlashCommandBuilder()
    .setName(
      'setup'
    )
    .setDescription(
      'Cài đặt Voice HDK cho Server'
    )
    .setDefaultMemberPermissions(
      PermissionsBitField.Flags.ManageGuild
    ),

  new SlashCommandBuilder()
    .setName(
      'panel'
    )
    .setDescription(
      'Kiểm tra và sửa bảng điều khiển phòng'
    ),

  new SlashCommandBuilder()
    .setName(
      'claim'
    )
    .setDescription(
      'Nhận quyền chủ phòng khi chủ cũ không còn hợp lệ'
    ),

  new SlashCommandBuilder()
    .setName(
      'doctor'
    )
    .setDescription(
      'Kiểm tra trạng thái Voice HDK'
    )
    .setDefaultMemberPermissions(
      PermissionsBitField.Flags.ManageGuild
    )
];

async function registerSlashCommands() {
  await client.application.commands.set(
    slashCommands.map(
      command =>
        command.toJSON()
    )
  );
}

async function handlePanelCommand(
  interaction
) {
  if (
    !interaction.inGuild()
  ) {
    return tempReply(
      interaction,
      'Lệnh này chỉ dùng trong Server.',
      'warning'
    );
  }

  const member =
    await fetchMemberSafe(
      interaction.guild,
      interaction.user.id
    );

  if (!member) {
    return tempReply(
      interaction,
      'Không thể xác minh thành viên.',
      'error'
    );
  }

  let channel =
    member.voice?.channel ||
    null;

  let room =
    channel
      ? await getRoom(
          channel.id
        )
      : null;

  if (!room) {
    const owned =
      await getOwnedRoom(
        interaction.guildId,
        interaction.user.id
      );

    if (owned) {
      channel =
        await fetchChannelSafe(
          interaction.guild,
          owned.channel_id
        );

      if (
        isVoiceChannel(
          channel
        )
      ) {
        room =
          owned;
      }
    }
  }

  if (
    !room ||
    !isVoiceChannel(
      channel
    )
  ) {
    return tempReply(
      interaction,
      'Bạn chưa có phòng Voice HDK để sửa panel.',
      'warning'
    );
  }

  if (
    String(
      room.owner_id
    ) !==
      String(
        interaction.user.id
      ) &&
    !interaction.memberPermissions?.has(
      PermissionsBitField.Flags.ManageGuild
    )
  ) {
    return tempReply(
      interaction,
      'Chỉ chủ phòng hoặc quản trị viên mới có thể sửa panel.',
      'warning'
    );
  }

  await interaction.deferReply({
    ephemeral:
      true
  });

  /*
    Không xóa panel rồi tạo lại.
    refreshRoomPanelSafe ưu tiên:
    1. Edit panel đã lưu
    2. Tìm panel cũ và nhận lại
    3. Chỉ tạo mới nếu thật sự không còn panel
  */
  const panel =
    await refreshRoomPanelSafe(
      channel.id
    );

  if (!panel) {
    return tempReply(
      interaction,
      'Không thể khôi phục panel lúc này.',
      'error'
    );
  }

  return tempReply(
    interaction,
    'Panel đã được kiểm tra và đồng bộ.',
    'success'
  );
}

async function handleClaimCommand(
  interaction
) {
  if (
    !interaction.inGuild()
  ) {
    return tempReply(
      interaction,
      'Lệnh này chỉ dùng trong Server.',
      'warning'
    );
  }

  const member =
    await fetchMemberSafe(
      interaction.guild,
      interaction.user.id
    );

  const channel =
    member?.voice?.channel;

  if (
    !member ||
    !isVoiceChannel(
      channel
    )
  ) {
    return tempReply(
      interaction,
      'Bạn cần ở trong một phòng Voice HDK.',
      'warning'
    );
  }

  const room =
    await getRoom(
      channel.id
    );

  if (!room) {
    return tempReply(
      interaction,
      'Phòng hiện tại không phải phòng Voice HDK.',
      'warning'
    );
  }

  if (
    String(
      room.owner_id
    ) ===
    String(
      member.id
    )
  ) {
    return tempReply(
      interaction,
      'Bạn đã là chủ phòng này.',
      'info'
    );
  }

  const absence =
    await getOwnerAbsence(
      channel.id
    );

  if (absence) {
    return tempReply(
      interaction,
      `Quyền chủ phòng đang được bảo lưu. Hệ thống sẽ xử lý ${relativeTimestamp(absence.deadline_at)}.`,
      'warning'
    );
  }

  const currentOwner =
    await fetchMemberSafe(
      interaction.guild,
      room.owner_id
    );

  if (
    currentOwner &&
    String(
      currentOwner.voice?.channelId ||
      ''
    ) ===
    String(
      channel.id
    )
  ) {
    return tempReply(
      interaction,
      'Chủ phòng hiện tại vẫn đang ở trong phòng.',
      'warning'
    );
  }

  const ownsOther =
    await memberOwnsOtherRoom(
      interaction.guildId,
      member.id,
      channel.id
    );

  if (ownsOther) {
    return tempReply(
      interaction,
      'Bạn đang sở hữu một phòng Voice HDK khác.',
      'warning'
    );
  }

  await interaction.deferReply({
    ephemeral:
      true
  });

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

    const current =
      locked.rows[0];

    if (!current) {
      throw new Error(
        'CLAIM_ROOM_MISSING'
      );
    }

    const conflict =
      await dbClient.query(
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
          interaction.guildId,
          member.id,
          channel.id
        ]
      );

    if (
      conflict.rowCount >
      0
    ) {
      throw new Error(
        'CLAIM_OWNER_CONFLICT'
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

    dbClient.release();

    return tempReply(
      interaction,
      error?.message ===
        'CLAIM_OWNER_CONFLICT'
        ? 'Bạn đang sở hữu một phòng Voice HDK khác.'
        : 'Không thể nhận quyền chủ phòng lúc này.',
      error?.message ===
        'CLAIM_OWNER_CONFLICT'
        ? 'warning'
        : 'error'
    );
  }

  dbClient.release();

  const granted =
    await grantRoomOwnerPermissions(
      channel,
      member
    );

  if (!granted) {
    await updateRoomOwner(
      channel.id,
      room.owner_id
    ).catch(
      error => {
        logError(
          'CLAIM_DB_ROLLBACK',
          error
        );
      }
    );

    return tempReply(
      interaction,
      'Không thể cấp quyền chủ phòng nên thao tác đã được hủy.',
      'error'
    );
  }

  await revokeOldOwnerPermissions(
    channel,
    room.owner_id
  );

  await refreshRoomPanelSafe(
    channel.id
  );

  await sendActionLog(
    interaction.guild,
    `👑 ${safeMemberName(member)} » Nhận quyền chủ phòng ${channel.name}`
  );

  return tempReply(
    interaction,
    'Bạn đã trở thành chủ phòng.',
    'success'
  );
}

async function doctorDatabase() {
  const started =
    Date.now();

  try {
    const result =
      await pool.query(
        'SELECT NOW() AS now'
      );

    return {
      ok:
        Boolean(
          result.rows[0]?.now
        ),
      latency:
        Date.now() -
        started
    };
  } catch (error) {
    return {
      ok: false,
      latency:
        null,
      error:
        error?.message ||
        String(error)
    };
  }
}

async function doctorGuild(
  guild
) {
  const generator =
    await getGenerator(
      guild.id
    );

  if (!generator) {
    return {
      installed:
        false,
      generator:
        false,
      chatLog:
        false,
      actionLog:
        false,
      permissions: {
        ok: false,
        missing: []
      }
    };
  }

  const buttonCategory =
    await fetchChannelSafe(
      guild,
      generator.button_category_id
    );

  const blogCategory =
    await fetchChannelSafe(
      guild,
      generator.blog_category_id
    );

  const createVoice =
    await fetchChannelSafe(
      guild,
      generator.create_voice_id
    );

  const chatLog =
    await fetchChannelSafe(
      guild,
      generator.chat_log_channel_id
    );

  const actionLog =
    await fetchChannelSafe(
      guild,
      generator.action_log_channel_id
    );

  const permissions =
    await validateSetupCategories(
      guild,
      buttonCategory,
      blogCategory
    );

  return {
    installed:
      true,

    generator:
      isVoiceChannel(
        createVoice
      ),

    chatLog:
      isGuildTextChannel(
        chatLog
      ),

    actionLog:
      isGuildTextChannel(
        actionLog
      ),

    permissions
  };
}

async function handleDoctorCommand(
  interaction
) {
  if (
    !interaction.inGuild()
  ) {
    return tempReply(
      interaction,
      'Lệnh này chỉ dùng trong Server.',
      'warning'
    );
  }

  if (
    !interaction.memberPermissions?.has(
      PermissionsBitField.Flags.ManageGuild
    )
  ) {
    return tempReply(
      interaction,
      'Bạn cần quyền Quản lý Server để dùng /doctor.',
      'warning'
    );
  }

  await interaction.deferReply({
    ephemeral:
      true
  });

  const [
    database,
    guildStatus,
    regions
  ] =
    await Promise.all([
      doctorDatabase(),
      doctorGuild(
        interaction.guild
      ),
      fetchVoiceRegionsSafe(
        true
      )
    ]);

  const gatewayPing =
    Number.isFinite(
      client.ws.ping
    )
      ? Math.round(
          client.ws.ping
        )
      : null;

  const permissionText =
    guildStatus.permissions?.ok
      ? '✅ Đủ quyền'
      : (
          guildStatus.installed
            ? '⚠️ Thiếu quyền'
            : '➖ Chưa cài đặt'
        );

  const lines = [
    '🩺  VOICE HDK DOCTOR',
    '────────────────────────────',
    `Discord Gateway   ${client.isReady() ? '✅ Online' : '⚠️ Chưa sẵn sàng'}${gatewayPing !== null ? ` • ${gatewayPing}ms` : ''}`,
    `PostgreSQL        ${database.ok ? `✅ Online • ${database.latency}ms` : '⛔ Lỗi'}`,
    `Cài đặt Server    ${guildStatus.installed ? '✅ Có' : '⚠️ Chưa có'}`,
    `➕ Tạo phòng      ${guildStatus.generator ? '✅ OK' : '⚠️ Thiếu'}`,
    `💬 Nhật ký chat   ${guildStatus.chatLog ? '✅ OK' : '⚠️ Thiếu'}`,
    `⚙️ Nhật ký chức năng ${guildStatus.actionLog ? '✅ OK' : '⚠️ Thiếu'}`,
    `Quyền Bot         ${permissionText}`,
    `Voice Regions     ${regions.length > 0 ? `✅ ${regions.length} khu vực` : '⚠️ Không tải được'}`,
    '────────────────────────────'
  ];

  if (
    database.error
  ) {
    lines.push(
      `DB: ${compactLogText(database.error, 300)}`
    );
  }

  if (
    guildStatus.installed &&
    !guildStatus.permissions?.ok
  ) {
    const detail =
      setupPermissionErrorText(
        guildStatus.permissions
      );

    if (detail) {
      lines.push(
        '',
        detail
      );
    }
  }

  return tempReply(
    interaction,
    lines.join('\n'),
    database.ok
      ? 'info'
      : 'error'
  );
}

async function reconcileRoom(
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
    clearStaleRuntimeState(
      room.channel_id
    );

    await deleteRoomRecord(
      room.channel_id
    );

    return;
  }

  await ensureOwnerDirectPermissions(
    channel,
    room.owner_id
  );

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
    scheduleEmptyRoomCheck(
      channel.id
    );

    return;
  }

  await refreshRoomPanelSafe(
    channel.id
  );

  const owner =
    await fetchMemberSafe(
      guild,
      room.owner_id
    );

  if (
    owner &&
    String(
      owner.voice?.channelId ||
      ''
    ) ===
    String(
      channel.id
    )
  ) {
    await cancelOwnerAbsence(
      channel.id
    ).catch(
      () => {}
    );

    return;
  }

  const absence =
    await getOwnerAbsence(
      channel.id
    );

  if (absence) {
    scheduleOwnerAbsenceTimer(
      channel.id,
      absence.deadline_at
    );

    return;
  }

  await beginOwnerAbsence(
    room,
    channel,
    owner
  );
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

  try {
    await ensureGeneratorVoiceChannel(
      guild,
      generator
    );

    await ensureManagedLogChannels(
      guild,
      generator
    );
  } catch (error) {
    logError(
      `RECONCILE_GENERATOR_${guild.id}`,
      error
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
    try {
      await reconcileRoom(
        guild,
        room
      );
    } catch (error) {
      logError(
        `RECONCILE_ROOM_${room.channel_id}`,
        error
      );
    }
  }
}

async function reconcileAllGuilds() {
  for (
    const guild
    of client.guilds.cache.values()
  ) {
    await reconcileGuild(
      guild
    );
  }
}

async function routeSlashCommand(
  interaction
) {
  switch (
    interaction.commandName
  ) {
    case 'setup':
      return handleSetupCommand(
        interaction
      );

    case 'panel':
      return handlePanelCommand(
        interaction
      );

    case 'claim':
      return handleClaimCommand(
        interaction
      );

    case 'doctor':
      return handleDoctorCommand(
        interaction
      );

    default:
      return;
  }
}

async function routeButton(
  interaction
) {
  switch (
    interaction.customId
  ) {
    case 'setup_name':
      return handleSetupNameButton(
        interaction
      );

    case 'setup_install':
      return handleSetupInstall(
        interaction
      );

    case 'setup_cancel':
      return handleSetupCancel(
        interaction
      );

    case 'setup_reinstall_confirm':
      return handleSetupReinstallConfirm(
        interaction
      );

    case 'setup_reinstall_cancel':
      return handleSetupReinstallCancel(
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
      return handleRoomResetButton(
        interaction
      );

    case 'room_reset_confirm':
      return handleRoomResetConfirm(
        interaction
      );

    case 'room_reset_cancel':
      return handleRoomResetCancel(
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

    case 'room_deny':
      return handleRoomDeny(
        interaction
      );

    case 'room_kick':
      return handleRoomKick(
        interaction
      );

    case 'room_transfer':
      return handleRoomTransferButton(
        interaction
      );

    case 'transfer_accept':
      return handleTransferAccept(
        interaction
      );

    case 'transfer_decline':
      return handleTransferDecline(
        interaction
      );

    default:
      return;
  }
}

async function routeSelectMenu(
  interaction
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

    case 'room_member':
      return handleRoomMemberSelect(
        interaction
      );

    case 'room_region':
      return handleRoomRegionSelect(
        interaction
      );

    default:
      return;
  }
}

async function routeModal(
  interaction
) {
  switch (
    interaction.customId
  ) {
    case 'setup_name_modal':
      return handleSetupNameModal(
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

client.on(
  Events.InteractionCreate,
  async interaction => {
    try {
      if (
        interaction.isChatInputCommand()
      ) {
        await routeSlashCommand(
          interaction
        );

        return;
      }

      if (
        interaction.isButton()
      ) {
        await routeButton(
          interaction
        );

        return;
      }

      if (
        interaction.isChannelSelectMenu() ||
        interaction.isUserSelectMenu() ||
        interaction.isStringSelectMenu()
      ) {
        await routeSelectMenu(
          interaction
        );

        return;
      }

      if (
        interaction.isModalSubmit()
      ) {
        await routeModal(
          interaction
        );
      }
    } catch (error) {
      logError(
        'INTERACTION_CREATE',
        error
      );

      try {
        await tempInteractionNotice(
          interaction,
          'Đã xảy ra lỗi khi xử lý thao tác. Hãy thử lại.',
          'error'
        );
      } catch (
        noticeError
      ) {
        logError(
          'INTERACTION_ERROR_NOTICE',
          noticeError
        );
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
      const member =
        newState.member ||
        oldState.member;

      if (
        !member ||
        member.user?.bot
      ) {
        return;
      }

      const guild =
        newState.guild ||
        oldState.guild;

      if (!guild) {
        return;
      }

      const oldChannelId =
        oldState.channelId ||
        null;

      const eventNewChannelId =
        newState.channelId ||
        null;

      /*
        Xóa presence ở phòng cũ trước.
      */
      if (
        oldChannelId &&
        oldChannelId !==
          eventNewChannelId
      ) {
        const oldChannel =
          oldState.channel ||
          await fetchChannelSafe(
            guild,
            oldChannelId
          );

        if (oldChannel) {
          await recordVoiceLeaveIfManaged(
            oldChannel,
            member
          );
        }
      }

      /*
        Xử lý generator trước.
        Hàm này có thể di chuyển user sang phòng khác,
        nên newState ban đầu có thể không còn phản ánh
        voice state thật sau khi hàm chạy.
      */
      if (
        eventNewChannelId
      ) {
        await handleJoinCreateVoice(
          newState
        );
      }

      /*
        Fetch member lại để lấy channel thực tế.
        Đây là fix cho lỗi chủ phòng vào generator
        rồi bị hiểu nhầm là đã rời phòng.
      */
      const freshMember =
        await fetchMemberSafe(
          guild,
          member.id
        );

      const actualChannelId =
        freshMember?.voice?.channelId ||
        null;

      if (
        actualChannelId
      ) {
        const actualChannel =
          await fetchChannelSafe(
            guild,
            actualChannelId
          );

        if (actualChannel) {
          await recordVoiceJoinIfManaged(
            actualChannel,
            freshMember
          );
        }
      }

      await handleActualOwnerState(
        guild,
        oldChannelId,
        freshMember ||
        member
      );

      const refreshIds =
        new Set(
          [
            oldChannelId,
            eventNewChannelId,
            actualChannelId
          ].filter(Boolean)
        );

      for (
        const channelId
        of refreshIds
      ) {
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
          await refreshRoomAfterVoiceChange(
            channel
          );
        }
      }
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
      if (
        !channel?.guild
      ) {
        return;
      }

      const guildId =
        channel.guild.id;

      /*
        Trong lúc /setup đang chủ động cleanup,
        không reconcile/recreate generator.
      */
      if (
        setupCleanupGuilds.has(
          guildId
        )
      ) {
        return;
      }

      const room =
        await getRoom(
          channel.id
        );

      if (room) {
        clearStaleRuntimeState(
          channel.id
        );

        await deleteRoomRecord(
          channel.id
        );

        return;
      }

      const generator =
        await getGenerator(
          guildId
        );

      if (!generator) {
        return;
      }

      if (
        String(
          generator.create_voice_id ||
          ''
        ) ===
        String(
          channel.id
        )
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
            guildId
          ]
        );

        const timer =
          setTimeout(
            async () => {
              try {
                const fresh =
                  await getGenerator(
                    guildId
                  );

                if (
                  fresh &&
                  !setupCleanupGuilds.has(
                    guildId
                  )
                ) {
                  await ensureGeneratorVoiceChannel(
                    channel.guild,
                    fresh
                  );
                }
              } catch (error) {
                logError(
                  'RECREATE_GENERATOR',
                  error
                );
              }
            },
            1500
          );

        timer.unref?.();

        return;
      }

      let updateNeeded =
        false;

      const values = {
        chat:
          generator.chat_log_channel_id,
        action:
          generator.action_log_channel_id
      };

      if (
        String(
          values.chat ||
          ''
        ) ===
        String(
          channel.id
        )
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
            guildId
          ]
        );

        updateNeeded =
          true;
      }

      if (
        String(
          values.action ||
          ''
        ) ===
        String(
          channel.id
        )
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
            guildId
          ]
        );

        updateNeeded =
          true;
      }

      if (updateNeeded) {
        const timer =
          setTimeout(
            async () => {
              try {
                const fresh =
                  await getGenerator(
                    guildId
                  );

                if (
                  fresh &&
                  !setupCleanupGuilds.has(
                    guildId
                  )
                ) {
                  await ensureManagedLogChannels(
                    channel.guild,
                    fresh
                  );
                }
              } catch (error) {
                logError(
                  'RECREATE_LOG_CHANNELS',
                  error
                );
              }
            },
            1500
          );

        timer.unref?.();
      }
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
      await sendChatCreateLog(
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
      await sendChatEditLog(
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
      await sendChatDeleteLog(
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
  Events.MessageBulkDelete,
  async messages => {
    try {
      await sendBulkDeleteLog(
        messages
      );
    } catch (error) {
      logError(
        'MESSAGE_BULK_DELETE_LOG',
        error
      );
    }
  }
);

client.once(
  Events.ClientReady,
  async readyClient => {
    console.log(
      `✅ ${BOT_NAME} online: ${readyClient.user.tag}`
    );

    try {
      await registerSlashCommands();

      console.log(
        '✅ Slash commands đã đồng bộ.'
      );
    } catch (error) {
      logError(
        'REGISTER_COMMANDS',
        error
      );
    }

    try {
      await fetchVoiceRegionsSafe(
        true
      );
    } catch (error) {
      logError(
        'INITIAL_REGION_FETCH',
        error
      );
    }

    try {
      await reconcileAllGuilds();

      console.log(
        '✅ Reconcile hoàn tất.'
      );
    } catch (error) {
      logError(
        'INITIAL_RECONCILE',
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

  shuttingDown =
    true;

  console.log(
    `🛑 Nhận ${signal}, đang tắt ${BOT_NAME}...`
  );

  for (
    const timer
    of emptyRoomTimers.values()
  ) {
    clearTimeout(
      timer
    );
  }

  for (
    const timer
    of ownerAbsenceTimers.values()
  ) {
    clearTimeout(
      timer
    );
  }

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

  emptyRoomTimers.clear();
  ownerAbsenceTimers.clear();
  pendingTransfers.clear();

  try {
    client.destroy();
  } catch (error) {
    logError(
      'SHUTDOWN_DISCORD',
      error
    );
  }

  try {
    await pool.end();
  } catch (error) {
    logError(
      'SHUTDOWN_DATABASE',
      error
    );
  }

  try {
    healthServer.close();
  } catch (error) {
    logError(
      'SHUTDOWN_HTTP',
      error
    );
  }

  process.exit(0);
}

process.once(
  'SIGTERM',
  () => {
    gracefulShutdown(
      'SIGTERM'
    ).catch(
      error => {
        logError(
          'SIGTERM_SHUTDOWN',
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
    gracefulShutdown(
      'SIGINT'
    ).catch(
      error => {
        logError(
          'SIGINT_SHUTDOWN',
          error
        );

        process.exit(1);
      }
    );
  }
);

async function startBot() {
  console.log(
    `🚀 Đang khởi động ${BOT_NAME} ${BOT_VERSION}...`
  );

  /*
    Database là thành phần bắt buộc.
    Nếu DB lỗi, bot KHÔNG giả vờ online.
  */
  await initDatabase();

  console.log(
    '✅ PostgreSQL sẵn sàng.'
  );

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
            `✅ Health server: 0.0.0.0:${PORT}`
          );

          resolve();
        }
      );
    }
  );

  try {
    await client.login(
      TOKEN
    );
  } catch (error) {
    try {
      healthServer.close();
    } catch (
      closeError
    ) {}

    throw error;
  }
}

startBot().catch(
  error => {
    logError(
      'STARTUP_FATAL',
      error
    );

    try {
      client.destroy();
    } catch (
      destroyError
    ) {}

    try {
      healthServer.close();
    } catch (
      closeError
    ) {}

    pool.end()
      .catch(
        () => {}
      )
      .finally(
        () => {
          process.exit(1);
        }
      );
  }
);

// UPTIMEROBOT / RENDER FREE
// URL: https://TEN-SERVICE-CUA-BAN.onrender.com/health
// Method: GET
