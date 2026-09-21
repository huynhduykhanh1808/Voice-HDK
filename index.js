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
const BOT_VERSION = '6.0.0';

const TOKEN = String(
  process.env.DISCORD_TOKEN ||
  process.env.TOKEN ||
  ''
).trim();

const DATABASE_URL = String(
  process.env.DATABASE_URL ||
  ''
).trim();

const PORT = Number(
  process.env.PORT ||
  8080
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

const SUCCESS_DELETE_MS =
  3000;

const ERROR_DELETE_MS =
  4000;

const ACTION_COOLDOWN_MS =
  1500;

const TRANSFER_TIMEOUT_MS =
  60000;

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
    'Thiếu DISCORD_TOKEN hoặc TOKEN trong Environment.'
  );
}

if (!DATABASE_URL) {
  throw new Error(
    'Thiếu DATABASE_URL trong Environment.'
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

let regionCache = {
  expiresAt: 0,
  regions: []
};

let shuttingDown =
  false;

const REQUIRED_PERMISSIONS = [
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.SendMessages,
  PermissionsBitField.Flags.EmbedLinks,
  PermissionsBitField.Flags.ReadMessageHistory,
  PermissionsBitField.Flags.ManageChannels,
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.MoveMembers,
  PermissionsBitField.Flags.Connect
];

const PERMISSION_NAMES =
  new Map([
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
      'Kết nối Voice'
    ]
  ]);

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

    process.exitCode = 1;

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
    (req, res) => {
      if (
        req.url === '/' ||
        req.url === '/health'
      ) {
        const body =
          JSON.stringify({
            ok: true,
            service:
              BOT_NAME,
            version:
              BOT_VERSION
          });

        res.writeHead(
          200,
          {
            'Content-Type':
              'application/json; charset=utf-8',
            'Content-Length':
              Buffer.byteLength(
                body
              ),
            'Cache-Control':
              'no-store'
          }
        );

        res.end(
          body
        );

        return;
      }

      const body =
        JSON.stringify({
          ok: false,
          error: 'Not Found'
        });

      res.writeHead(
        404,
        {
          'Content-Type':
            'application/json; charset=utf-8',
          'Content-Length':
            Buffer.byteLength(
              body
            )
        }
      );

      res.end(
        body
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
    result.rowCount > 0
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
      'Tên bảng hoặc cột không hợp lệ.'
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

    await dbClient.query(
      `
        CREATE TABLE IF NOT EXISTS generators (
          guild_id BIGINT PRIMARY KEY
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
        ADD COLUMN IF NOT EXISTS installed_at TIMESTAMPTZ
      `
    );

    await dbClient.query(
      `
        ALTER TABLE generators
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
      `
    );

    await dbClient.query(
      `
        CREATE TABLE IF NOT EXISTS rooms (
          guild_id BIGINT NOT NULL,
          channel_id BIGINT PRIMARY KEY,
          owner_id BIGINT NOT NULL,
          category_id BIGINT,
          control_message_id BIGINT,
          created_at TIMESTAMPTZ DEFAULT NOW()
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
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()
      `
    );

    await dbClient.query(
      `
        DELETE FROM rooms a
        USING rooms b
        WHERE
          a.guild_id = b.guild_id
          AND a.owner_id = b.owner_id
          AND a.channel_id <> b.channel_id
          AND (
            COALESCE(
              a.created_at,
              TO_TIMESTAMP(0)
            ),
            a.channel_id
          ) < (
            COALESCE(
              b.created_at,
              TO_TIMESTAMP(0)
            ),
            b.channel_id
          )
      `
    );

    await dbClient.query(
      `
        CREATE UNIQUE INDEX IF NOT EXISTS
          rooms_one_owner_per_guild
        ON rooms (
          guild_id,
          owner_id
        )
      `
    );

    await dbClient.query(
      `
        CREATE INDEX IF NOT EXISTS
          rooms_guild_id_idx
        ON rooms (
          guild_id
        )
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
    try {
      await dropNotNullIfColumnExists(
        'generators',
        columnName
      );
    } catch (error) {
      logError(
        `MIGRATION_GENERATORS_${columnName}`,
        error
      );
    }
  }

  console.log(
    `[${BOT_NAME}] Database đã sẵn sàng.`
  );
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
        String(
          guildId
        )
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
          NOW(),
          NOW()
        )
        ON CONFLICT (guild_id)
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
          installed_at =
            COALESCE(
              generators.installed_at,
              NOW()
            ),
          updated_at =
            NOW()
        RETURNING *
      `,
      [
        String(
          guildId
        ),
        displayName,
        String(
          buttonCategoryId
        ),
        String(
          blogCategoryId
        ),
        String(
          createVoiceId
        ),
        String(
          chatLogChannelId
        ),
        String(
          actionLogChannelId
        )
      ]
    );

  return result.rows[0];
}

async function deleteGenerator(
  guildId
) {
  await pool.query(
    `
      DELETE FROM generators
      WHERE guild_id = $1
    `,
    [
      String(
        guildId
      )
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
        tracked_text_channel_id = $1,
        updated_at = NOW()
      WHERE guild_id = $2
    `,
    [
      channelId
        ? String(
            channelId
          )
        : null,
      String(
        guildId
      )
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
        String(
          channelId
        )
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
        String(
          guildId
        ),
        String(
          ownerId
        )
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
        String(
          guildId
        )
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
        String(
          guildId
        ),
        String(
          channelId
        ),
        String(
          ownerId
        ),
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
  await pool.query(
    `
      UPDATE rooms
      SET control_message_id = $1
      WHERE channel_id = $2
    `,
    [
      messageId
        ? String(
            messageId
          )
        : null,
      String(
        channelId
      )
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
        String(
          ownerId
        ),
        String(
          channelId
        )
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
      DELETE FROM rooms
      WHERE channel_id = $1
    `,
    [
      String(
        channelId
      )
    ]
  );
}

async function deleteGuildRoomRecords(
  guildId,
  dbClient = pool
) {
  await dbClient.query(
    `
      DELETE FROM rooms
      WHERE guild_id = $1
    `,
    [
      String(
        guildId
      )
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
    value ||
    ''
  )
    .replace(
      /[`\r\n\t]/g,
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
  let name =
    String(
      value ||
      ''
    )
      .replace(
        /[\r\n\t]/g,
        ' '
      )
      .replace(
        /\s+/g,
        ' '
      )
      .trim();

  if (
    name.startsWith(
      ROOM_PREFIX
    )
  ) {
    name =
      name.slice(
        ROOM_PREFIX.length
      );
  }

  name =
    name
      .replace(
        /^➕\s*/u,
        ''
      )
      .trim();

  if (!name) {
    name =
      'Phòng thoại';
  }

  return name.slice(
    0,
    80
  );
}

function safeMemberName(
  member
) {
  if (!member) {
    return 'Không xác định';
  }

  return (
    cleanDisplayName(
      member.displayName
    ) ||
    cleanDisplayName(
      member.user?.globalName
    ) ||
    cleanDisplayName(
      member.user?.username
    ) ||
    'Không xác định'
  );
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
        ] =
          part.value;
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
  } catch {
    return (
      new Date(
        date
      ).toISOString()
    );
  }
}

function relativeTimestamp(
  timeMs
) {
  const unix =
    Math.floor(
      Number(
        timeMs
      ) /
      1000
    );

  return (
    `<t:${unix}:R>`
  );
}

function permissionNames(
  permissions
) {
  return (
    permissions.map(
      permission =>
        PERMISSION_NAMES.get(
          permission
        ) ||
        String(
          permission
        )
    )
  );
}

function sleep(
  ms
) {
  return new Promise(
    resolve => {
      const timer =
        setTimeout(
          resolve,
          ms
        );

      timer.unref?.();
    }
  );
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
  selectedMembers.set(
    selectedMemberKey(
      guildId,
      channelId,
      ownerId
    ),
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

  const data =
    selectedMembers.get(
      key
    );

  if (!data) {
    return null;
  }

  if (
    data.expiresAt <=
    Date.now()
  ) {
    selectedMembers.delete(
      key
    );

    return null;
  }

  return data.memberId;
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

function clearSelectionsForChannel(
  guildId,
  channelId
) {
  const prefix =
    `${guildId}:${channelId}:`;

  for (
    const key
    of selectedMembers.keys()
  ) {
    if (
      key.startsWith(
        prefix
      )
    ) {
      selectedMembers.delete(
        key
      );
    }
  }
}

function setupSessionKey(
  guildId,
  userId
) {
  return (
    `${guildId}:${userId}`
  );
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

function saveSetupSession(
  guildId,
  userId,
  data = {}
) {
  const key =
    setupSessionKey(
      guildId,
      userId
    );

  const current =
    getSetupSession(
      guildId,
      userId
    ) || {};

  const session = {
    ...current,
    ...data,
    guildId:
      String(
        guildId
      ),
    userId:
      String(
        userId
      ),
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

    return null;
  }

  return transfer;
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

function cooldownKey(
  userId,
  action
) {
  return (
    `${userId}:${action}`
  );
}

function useCooldown(
  userId,
  action,
  duration =
    ACTION_COOLDOWN_MS
) {
  const key =
    cooldownKey(
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
    expiresAt > now
  ) {
    return (
      expiresAt -
      now
    );
  }

  const next =
    now +
    duration;

  cooldowns.set(
    key,
    next
  );

  const timer =
    setTimeout(
      () => {
        if (
          (
            cooldowns.get(
              key
            ) || 0
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

  let release;

  const current =
    new Promise(
      resolve => {
        release =
          resolve;
      }
    );

  const chain =
    previous
      .catch(
        () => {}
      )
      .then(
        () => current
      );

  map.set(
    lockKey,
    chain
  );

  await previous.catch(
    () => {}
  );

  try {
    return await task();
  } finally {
    release();

    if (
      map.get(
        lockKey
      ) === chain
    ) {
      map.delete(
        lockKey
      );
    }
  }
}

function withPanelLock(
  channelId,
  task
) {
  return withLock(
    panelLocks,
    channelId,
    task
  );
}

function withCreateLock(
  guildId,
  ownerId,
  task
) {
  return withLock(
    createLocks,
    `${guildId}:${ownerId}`,
    task
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

async function getGuildMember(
  guild,
  memberId
) {
  const id =
    String(
      memberId || ''
    );

  if (
    !guild ||
    !isSnowflake(
      id
    )
  ) {
    return null;
  }

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
  const id =
    String(
      channelId || ''
    );

  if (
    !guild ||
    !isSnowflake(
      id
    )
  ) {
    return null;
  }

  const cached =
    guild.channels.cache.get(
      id
    );

  if (cached) {
    return cached;
  }

  try {
    return await guild.channels.fetch(
      id
    );
  } catch {
    return null;
  }
}

async function getGuildRole(
  guild,
  roleId
) {
  const id =
    String(
      roleId || ''
    );

  if (
    !guild ||
    !isSnowflake(
      id
    )
  ) {
    return null;
  }

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

function getMissingPermissions(
  permissions
) {
  if (!permissions) {
    return [
      ...REQUIRED_PERMISSIONS
    ];
  }

  return (
    REQUIRED_PERMISSIONS.filter(
      permission =>
        !permissions.has(
          permission
        )
    )
  );
}

function canManageSetup(
  interaction
) {
  if (
    !interaction?.guild
  ) {
    return false;
  }

  const permissions =
    interaction.memberPermissions;

  if (!permissions) {
    return false;
  }

  return (
    permissions.has(
      PermissionsBitField.Flags.Administrator
    ) ||
    permissions.has(
      PermissionsBitField.Flags.ManageGuild
    )
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
        'Không tìm thấy bot trong server'
      ]
    };
  }

  const missing = [];

  const globalMissing =
    getMissingPermissions(
      botMember.permissions
    );

  for (
    const name
    of permissionNames(
      globalMissing
    )
  ) {
    if (
      !missing.includes(
        name
      )
    ) {
      missing.push(
        name
      );
    }
  }

  for (
    const category
    of [
      buttonCategory,
      blogCategory
    ]
  ) {
    if (!category) {
      continue;
    }

    const permissions =
      category.permissionsFor(
        botMember
      );

    const categoryMissing =
      getMissingPermissions(
        permissions
      );

    for (
      const name
      of permissionNames(
        categoryMissing
      )
    ) {
      const description =
        `${name} trong "${category.name}"`;

      if (
        !missing.includes(
          description
        )
      ) {
        missing.push(
          description
        );
      }
    }
  }

  return {
    ok:
      missing.length === 0,
    missing
  };
}

async function resolveOverwriteTarget(
  guild,
  targetId,
  expectedType = null
) {
  const id =
    String(
      targetId || ''
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
    expectedType ===
      OverwriteType.Role
  ) {
    const role =
      await getGuildRole(
        guild,
        id
      );

    if (!role) {
      return null;
    }

    return {
      id:
        role.id,
      type:
        OverwriteType.Role
    };
  }

  if (
    expectedType ===
      OverwriteType.Member
  ) {
    const member =
      await getGuildMember(
        guild,
        id
      );

    if (!member) {
      return null;
    }

    return {
      id:
        member.id,
      type:
        OverwriteType.Member
    };
  }

  const role =
    await getGuildRole(
      guild,
      id
    );

  if (role) {
    return {
      id:
        role.id,
      type:
        OverwriteType.Role
    };
  }

  const member =
    await getGuildMember(
      guild,
      id
    );

  if (member) {
    return {
      id:
        member.id,
      type:
        OverwriteType.Member
    };
  }

  return null;
}

async function safeEditOverwrite(
  channel,
  targetId,
  permissions,
  reason,
  expectedType = null
) {
  if (
    !channel?.guild
  ) {
    throw new Error(
      'Kênh Discord không hợp lệ.'
    );
  }

  const target =
    await resolveOverwriteTarget(
      channel.guild,
      targetId,
      expectedType
    );

  if (!target) {
    throw new Error(
      'Không tìm thấy thành viên hoặc vai trò hợp lệ để cập nhật quyền.'
    );
  }

  await channel.permissionOverwrites.edit(
    target.id,
    permissions,
    {
      type:
        target.type,
      reason
    }
  );

  return true;
}

async function safeDeleteOverwrite(
  channel,
  targetId,
  reason
) {
  if (
    !channel?.guild
  ) {
    return false;
  }

  const id =
    String(
      targetId || ''
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
      'DELETE_PERMISSION_OVERWRITE',
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
    botMember.id,
    {
      ViewChannel: true,
      Connect: true,
      SendMessages: true,
      ReadMessageHistory: true,
      ManageChannels: true,
      ManageRoles: true,
      MoveMembers: true
    },
    `${BOT_NAME}: bảo đảm quyền quản lý phòng`,
    OverwriteType.Member
  );
}

async function grantOwnerPermissions(
  channel,
  ownerId
) {
  const owner =
    await getGuildMember(
      channel.guild,
      ownerId
    );

  if (!owner) {
    throw new Error(
      'Không tìm thấy chủ phòng trong server.'
    );
  }

  await safeEditOverwrite(
    channel,
    owner.id,
    {
      ViewChannel: true,
      Connect: true
    },
    `${BOT_NAME}: cấp quyền chủ phòng`,
    OverwriteType.Member
  );

  return owner;
}

async function removeOwnerPermissions(
  channel,
  ownerId
) {
  return safeDeleteOverwrite(
    channel,
    ownerId,
    `${BOT_NAME}: thu hồi quyền chủ phòng cũ`
  );
}

async function setRoomLocked(
  channel,
  locked
) {
  await safeEditOverwrite(
    channel,
    channel.guild.roles.everyone.id,
    {
      Connect:
        locked
          ? false
          : null
    },
    locked
      ? `${BOT_NAME}: khóa phòng`
      : `${BOT_NAME}: mở phòng`,
    OverwriteType.Role
  );
}

async function setRoomHidden(
  channel,
  hidden
) {
  await safeEditOverwrite(
    channel,
    channel.guild.roles.everyone.id,
    {
      ViewChannel:
        hidden
          ? false
          : null
    },
    hidden
      ? `${BOT_NAME}: ẩn phòng`
      : `${BOT_NAME}: hiện phòng`,
    OverwriteType.Role
  );
}

async function inviteMemberToRoom(
  channel,
  member
) {
  if (
    !member ||
    member.guild?.id !==
      channel.guild.id
  ) {
    throw new Error(
      'Thành viên không hợp lệ.'
    );
  }

  await safeEditOverwrite(
    channel,
    member.id,
    {
      ViewChannel: true,
      Connect: true
    },
    `${BOT_NAME}: mời thành viên vào phòng`,
    OverwriteType.Member
  );
}

async function denyMemberFromRoom(
  channel,
  member
) {
  if (
    !member ||
    member.guild?.id !==
      channel.guild.id
  ) {
    throw new Error(
      'Thành viên không hợp lệ.'
    );
  }

  await safeEditOverwrite(
    channel,
    member.id,
    {
      ViewChannel: false,
      Connect: false
    },
    `${BOT_NAME}: cấm thành viên khỏi phòng`,
    OverwriteType.Member
  );

  if (
    member.voice?.channelId ===
    channel.id
  ) {
    await member.voice.disconnect(
      `${BOT_NAME}: thành viên bị cấm khỏi phòng`
    );
  }
}

async function kickMemberFromRoom(
  channel,
  member
) {
  if (
    !member ||
    member.guild?.id !==
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
      'Thành viên được chọn không còn ở trong phòng này.'
    );
  }

  await member.voice.disconnect(
    `${BOT_NAME}: chủ phòng đuổi thành viên`
  );
}

async function clearMemberOverwrites(
  channel,
  keepMemberIds = []
) {
  const keep =
    new Set(
      keepMemberIds
        .filter(
          Boolean
        )
        .map(
          id =>
            String(
              id
            )
        )
    );

  const overwrites =
    [
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
      keep.has(
        overwrite.id
      )
    ) {
      continue;
    }

    await overwrite.delete(
      `${BOT_NAME}: đặt lại quyền riêng của thành viên`
    );
  }
}

async function resetRoomState(
  channel,
  ownerId
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

  await setRoomLocked(
    channel,
    false
  );

  await setRoomHidden(
    channel,
    false
  );

  await channel.setUserLimit(
    0,
    `${BOT_NAME}: đặt lại giới hạn phòng`
  );

  await channel.setRTCRegion(
    null,
    `${BOT_NAME}: đặt lại khu vực tự động`
  );

  await clearMemberOverwrites(
    channel,
    [
      String(
        ownerId
      ),
      botMember.id
    ]
  );

  await grantOwnerPermissions(
    channel,
    ownerId
  );

  await ensureBotRoomPermissions(
    channel
  );
}

function getRoomState(
  channel
) {
  const everyoneOverwrite =
    channel.permissionOverwrites.cache.get(
      channel.guild.roles.everyone.id
    );

  const locked =
    Boolean(
      everyoneOverwrite?.deny?.has(
        PermissionsBitField.Flags.Connect
      )
    );

  const hidden =
    Boolean(
      everyoneOverwrite?.deny?.has(
        PermissionsBitField.Flags.ViewChannel
      )
    );

  return {
    locked,
    hidden
  };
}

async function getRoomOwnerMember(
  room,
  guild
) {
  if (
    !room ||
    !guild
  ) {
    return null;
  }

  return getGuildMember(
    guild,
    String(
      room.owner_id
    )
  );
}

async function getSelectedMember(
  guild,
  channelId,
  ownerId
) {
  const memberId =
    getSelectedMemberId(
      guild.id,
      channelId,
      ownerId
    );

  if (!memberId) {
    return null;
  }

  const member =
    await getGuildMember(
      guild,
      memberId
    );

  if (!member) {
    clearSelectedMember(
      guild.id,
      channelId,
      ownerId
    );

    return null;
  }

  return member;
}

function deleteReplyLater(
  interaction,
  delay
) {
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
        } catch {
        }
      },
      delay
    );

  timer.unref?.();
}

function deleteMessageLater(
  message,
  delay
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
    return true;
  }

  try {
    await interaction.deferUpdate();

    return true;
  } catch (error) {
    logError(
      'DEFER_UPDATE',
      error
    );

    return false;
  }
}

async function safeDeferReply(
  interaction,
  ephemeral = true
) {
  if (
    interaction.deferred ||
    interaction.replied
  ) {
    return true;
  }

  try {
    await interaction.deferReply({
      ephemeral
    });

    return true;
  } catch (error) {
    logError(
      'DEFER_REPLY',
      error
    );

    return false;
  }
}

async function tempReply(
  interaction,
  content,
  {
    error = false
  } = {}
) {
  const delay =
    error
      ? ERROR_DELETE_MS
      : SUCCESS_DELETE_MS;

  try {
    if (
      interaction.deferred
    ) {
      await interaction.editReply({
        content,
        embeds: [],
        components: []
      });

      deleteReplyLater(
        interaction,
        delay
      );

      return null;
    }

    if (
      interaction.replied
    ) {
      const message =
        await interaction.followUp({
          content,
          ephemeral: true,
          fetchReply: true
        });

      deleteMessageLater(
        message,
        delay
      );

      return message;
    }

    await interaction.reply({
      content,
      ephemeral: true
    });

    deleteReplyLater(
      interaction,
      delay
    );

    return null;
  } catch (replyError) {
    logError(
      'TEMP_REPLY',
      replyError
    );

    return null;
  }
}

async function tempFollowUp(
  interaction,
  content,
  {
    error = false
  } = {}
) {
  const delay =
    error
      ? ERROR_DELETE_MS
      : SUCCESS_DELETE_MS;

  try {
    const message =
      await interaction.followUp({
        content,
        ephemeral: true,
        fetchReply: true
      });

    deleteMessageLater(
      message,
      delay
    );

    return message;
  } catch (followUpError) {
    logError(
      'TEMP_FOLLOWUP',
      followUpError
    );

    return null;
  }
}

async function getVoiceRegions(
  force = false
) {
  const now =
    Date.now();

  if (
    !force &&
    regionCache.regions.length &&
    regionCache.expiresAt > now
  ) {
    return regionCache.regions;
  }

  const fetched =
    await client.fetchVoiceRegions();

  const regions =
    fetched
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

          return (
            a.name.localeCompare(
              b.name,
              'vi'
            )
          );
        }
      );

  regionCache = {
    expiresAt:
      now +
      REGION_CACHE_MS,
    regions
  };

  return regions;
}

async function validateVoiceRegion(
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
    await getVoiceRegions();

  let region =
    regions.find(
      item =>
        item.id ===
        regionId
    );

  if (region) {
    return region;
  }

  regions =
    await getVoiceRegions(
      true
    );

  region =
    regions.find(
      item =>
        item.id ===
        regionId
    );

  return (
    region ||
    null
  );
}

async function fetchMessageSafe(
  channel,
  messageId
) {
  const id =
    String(
      messageId || ''
    );

  if (
    !channel?.messages ||
    !isSnowflake(
      id
    )
  ) {
    return null;
  }

  try {
    return await channel.messages.fetch(
      id
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
function buildSetupPanel(
  session
) {
  const displayName =
    cleanDisplayName(
      session?.displayName
    );

  const buttonCategoryId =
    isSnowflake(
      String(
        session?.buttonCategoryId ||
        ''
      )
    )
      ? String(
          session.buttonCategoryId
        )
      : null;

  const blogCategoryId =
    isSnowflake(
      String(
        session?.blogCategoryId ||
        ''
      )
    )
      ? String(
          session.blogCategoryId
        )
      : null;

  const ready =
    Boolean(
      displayName &&
      buttonCategoryId &&
      blogCategoryId
    );

  const embed =
    new EmbedBuilder()
      .setTitle(
        '⚙️ Thiết lập Voice HDK'
      )
      .setDescription(
        [
          '🏷️ **Tên Server**',
          displayName ||
            'Chưa nhập',
          '',
          '📁 **Danh mục đặt nút**',
          buttonCategoryId
            ? `<#${buttonCategoryId}>`
            : 'Chưa chọn',
          '',
          '📁 **Danh mục đặt Blog**',
          blogCategoryId
            ? `<#${blogCategoryId}>`
            : 'Chưa chọn',
          '',
          ready
            ? '✅ Đã đủ thông tin. Bạn có thể tiến hành cài đặt.'
            : 'ℹ️ Hãy nhập tên Server và chọn đủ 2 danh mục.'
        ].join(
          '\n'
        )
      )
      .setFooter({
        text:
          `✦ ${BOT_NAME} • Thiết lập hệ thống`
      });

  const nameRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'setup_name'
          )
          .setLabel(
            displayName
              ? 'Đổi tên Server'
              : 'Nhập tên Server'
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
            buttonCategoryId
              ? '📁 Đổi danh mục đặt nút'
              : '📁 Chọn danh mục đặt nút'
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
            blogCategoryId
              ? '📁 Đổi danh mục đặt Blog'
              : '📁 Chọn danh mục đặt Blog'
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
          .setDisabled(
            !ready
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
          'và cho phép bạn thiết lập lại từ đầu.',
          '',
          'Chỉ những kênh do Voice HDK đang quản lý mới được xóa.',
          'Danh mục Discord bạn đã chọn sẽ được giữ nguyên.'
        ].join(
          '\n'
        )
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

function buildSetupSuccessPanel({
  displayName,
  buttonCategoryId,
  blogCategoryId,
  createVoiceId
}) {
  const safeName =
    cleanDisplayName(
      displayName
    ) ||
    'Voice HDK';

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
          `🏷️ **Tên Server:** ${safeName}`,
          `📁 **Danh mục đặt nút:** <#${buttonCategoryId}>`,
          `➕ **Tạo phòng:** <#${createVoiceId}>`,
          `📁 **Danh mục đặt Blog:** <#${blogCategoryId}>`,
          '',
          'Thành viên chỉ cần vào **➕ Tạo phòng**.',
          'Bot sẽ tự tạo phòng riêng và chuyển thành viên vào phòng.',
          '',
          'Nếu có bất kỳ thắc mắc hoặc cần hỗ trợ:',
          '👤 **Huỳnh Duy Khánh**',
          '☎️ **0988850044**',
          '',
          'Cảm ơn bạn đã sử dụng Voice HDK ❤️'
        ].join(
          '\n'
        )
      )
      .setFooter({
        text:
          `✦ ${BOT_NAME} • ${safeName}`
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
      '❌ Bạn cần quyền **Quản lý Server** để cài đặt Voice HDK.',
      {
        error: true
      }
    );

    return;
  }

  let existing = null;

  try {
    existing =
      await getGenerator(
        interaction.guild.id
      );
  } catch (error) {
    logError(
      'SETUP_GET_GENERATOR',
      error
    );

    await tempReply(
      interaction,
      '❌ Không thể kiểm tra Database. Vui lòng thử lại.',
      {
        error: true
      }
    );

    return;
  }

  if (existing) {
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
        displayName: '',
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

  let session =
    getSetupSession(
      interaction.guild.id,
      interaction.user.id
    );

  if (!session) {
    session =
      saveSetupSession(
        interaction.guild.id,
        interaction.user.id,
        {
          displayName: '',
          buttonCategoryId:
            null,
          blogCategoryId:
            null
        }
      );
  }

  const modal =
    new ModalBuilder()
      .setCustomId(
        'setup_name_modal'
      )
      .setTitle(
        'Tên Server'
      );

  const input =
    new TextInputBuilder()
      .setCustomId(
        'setup_display_name'
      )
      .setLabel(
        'Tên hiển thị trên Voice HDK'
      )
      .setPlaceholder(
        'Ví dụ: ABCD'
      )
      .setStyle(
        TextInputStyle.Short
      )
      .setMinLength(
        1
      )
      .setMaxLength(
        50
      )
      .setRequired(
        true
      );

  if (
    session.displayName
  ) {
    input.setValue(
      session.displayName
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

  const session =
    saveSetupSession(
      interaction.guild.id,
      interaction.user.id,
      {
        displayName
      }
    );

  try {
    if (
      interaction.message
    ) {
      await interaction.message.edit(
        buildSetupPanel(
          session
        )
      );
    }

    await interaction.reply({
      content:
        `✅ Tên Server hiện tại: **${displayName}**`,
      ephemeral: true
    });

    deleteReplyLater(
      interaction,
      SUCCESS_DELETE_MS
    );
  } catch (error) {
    logError(
      'SETUP_NAME_MODAL',
      error
    );

    if (
      !interaction.replied &&
      !interaction.deferred
    ) {
      await tempReply(
        interaction,
        '❌ Không thể cập nhật tên Server.',
        {
          error: true
        }
      );
    }
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

  const categoryId =
    String(
      interaction.values?.[0] ||
      ''
    );

  if (
    !isSnowflake(
      categoryId
    )
  ) {
    await tempFollowUp(
      interaction,
      '❌ Danh mục được chọn không hợp lệ.',
      {
        error: true
      }
    );

    return;
  }

  const category =
    await getGuildChannel(
      interaction.guild,
      categoryId
    );

  if (
    !category ||
    category.type !==
      ChannelType.GuildCategory
  ) {
    await tempFollowUp(
      interaction,
      '❌ Vui lòng chọn đúng một Danh mục Discord.',
      {
        error: true
      }
    );

    return;
  }

  const session =
    saveSetupSession(
      interaction.guild.id,
      interaction.user.id,
      type === 'button'
        ? {
            buttonCategoryId:
              category.id
          }
        : {
            blogCategoryId:
              category.id
          }
    );

  try {
    await interaction.editReply(
      buildSetupPanel(
        session
      )
    );
  } catch (error) {
    logError(
      'SETUP_CATEGORY_REFRESH',
      error
    );
  }
}

async function safeDeleteManagedChannel(
  guild,
  channelId,
  reason
) {
  const id =
    String(
      channelId || ''
    );

  if (
    !guild ||
    !isSnowflake(
      id
    )
  ) {
    return true;
  }

  const channel =
    await getGuildChannel(
      guild,
      id
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
      `DELETE_MANAGED_CHANNEL:${id}`,
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

  if (!generator) {
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
    const channelId =
      String(
        room.channel_id
      );

    clearPendingTransfer(
      channelId
    );

    clearSelectionsForChannel(
      guild.id,
      channelId
    );

    clearEmptyRoomTimer(
      channelId
    );

    const deleted =
      await safeDeleteManagedChannel(
        guild,
        channelId,
        `${BOT_NAME}: cài đặt lại hệ thống`
      );

    if (!deleted) {
      throw new Error(
        `Không thể xóa phòng Voice HDK ${channelId}.`
      );
    }
  }

  const managedChannelIds =
    [
      generator.create_voice_id,
      generator.chat_log_channel_id,
      generator.action_log_channel_id
    ]
      .filter(
        Boolean
      )
      .map(
        id =>
          String(
            id
          )
      );

  for (
    const channelId
    of new Set(
      managedChannelIds
    )
  ) {
    const deleted =
      await safeDeleteManagedChannel(
        guild,
        channelId,
        `${BOT_NAME}: cài đặt lại hệ thống`
      );

    if (!deleted) {
      throw new Error(
        `Không thể xóa tài nguyên Voice HDK ${channelId}.`
      );
    }
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
      `
        DELETE FROM generators
        WHERE guild_id = $1
      `,
      [
        guild.id
      ]
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

  try {
    await cleanupGuildInstallation(
      interaction.guild
    );

    const session =
      saveSetupSession(
        interaction.guild.id,
        interaction.user.id,
        {
          displayName: '',
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
      'SETUP_REINSTALL',
      error
    );

    await tempFollowUp(
      interaction,
      `❌ Không thể cài đặt lại an toàn: ${String(
        error?.message ||
        'Lỗi không xác định.'
      ).slice(
        0,
        1000
      )}`,
      {
        error: true
      }
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
    interaction.guildId
  ) {
    deleteSetupSession(
      interaction.guildId,
      interaction.user.id
    );
  }

  try {
    await interaction.editReply({
      content:
        '✖️ Đã hủy cài đặt lại Voice HDK.',
      embeds: [],
      components: []
    });
  } catch (error) {
    logError(
      'SETUP_REINSTALL_CANCEL',
      error
    );
  }

  deleteReplyLater(
    interaction,
    SUCCESS_DELETE_MS
  );
}

async function createGeneratorVoiceChannel(
  guild,
  category
) {
  const botMember =
    await getBotMember(
      guild
    );

  if (!botMember) {
    throw new Error(
      'Không tìm thấy bot trong server.'
    );
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
    rtcRegion:
      null,
    reason:
      `${BOT_NAME}: tạo kênh tạo phòng`,
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
          botMember.id,
        type:
          OverwriteType.Member,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.Connect,
          PermissionsBitField.Flags.ManageChannels,
          PermissionsBitField.Flags.ManageRoles,
          PermissionsBitField.Flags.MoveMembers
        ]
      }
    ]
  });
}

async function createManagedLogChannel(
  guild,
  category,
  name,
  topic
) {
  const botMember =
    await getBotMember(
      guild
    );

  if (!botMember) {
    throw new Error(
      'Không tìm thấy bot trong server.'
    );
  }

  return guild.channels.create({
    name,
    type:
      ChannelType.GuildText,
    parent:
      category.id,
    topic,
    reason:
      `${BOT_NAME}: tạo Blog hệ thống`,
    permissionOverwrites: [
      {
        id:
          guild.roles.everyone.id,
        type:
          OverwriteType.Role,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.ReadMessageHistory
        ],
        deny: [
          PermissionsBitField.Flags.SendMessages
        ]
      },
      {
        id:
          botMember.id,
        type:
          OverwriteType.Member,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.EmbedLinks,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageChannels
        ]
      }
    ]
  });
}

async function rollbackSetupChannels(
  channels
) {
  for (
    const channel
    of [...channels].reverse()
  ) {
    if (!channel) {
      continue;
    }

    try {
      await channel.delete(
        `${BOT_NAME}: hoàn tác cài đặt lỗi`
      );
    } catch (error) {
      logError(
        `SETUP_ROLLBACK:${channel.id}`,
        error
      );
    }
  }
}

async function installGuildSystem(
  guild,
  session
) {
  const displayName =
    cleanDisplayName(
      session?.displayName
    );

  if (!displayName) {
    throw new Error(
      'Bạn chưa nhập tên Server.'
    );
  }

  const buttonCategory =
    await getGuildChannel(
      guild,
      String(
        session?.buttonCategoryId ||
        ''
      )
    );

  const blogCategory =
    await getGuildChannel(
      guild,
      String(
        session?.blogCategoryId ||
        ''
      )
    );

  if (
    !buttonCategory ||
    buttonCategory.type !==
      ChannelType.GuildCategory
  ) {
    throw new Error(
      'Danh mục đặt nút không còn tồn tại.'
    );
  }

  if (
    !blogCategory ||
    blogCategory.type !==
      ChannelType.GuildCategory
  ) {
    throw new Error(
      'Danh mục đặt Blog không còn tồn tại.'
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
    throw new Error(
      `Bot đang thiếu quyền: ${permissionCheck.missing.join(', ')}`
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
        CHAT_LOG_CHANNEL_NAME,
        `${BOT_NAME} • Nhật ký Chat`
      );

    created.push(
      chatLog
    );

    const actionLog =
      await createManagedLogChannel(
        guild,
        blogCategory,
        ACTION_LOG_CHANNEL_NAME,
        `${BOT_NAME} • Nhật ký Chức năng`
      );

    created.push(
      actionLog
    );

    let generator;

    try {
      generator =
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
    } catch (error) {
      logError(
        'SETUP_SAVE_DATABASE',
        error
      );

      await rollbackSetupChannels(
        created
      );

      throw new Error(
        'Không thể lưu cấu hình vào Database. Các kênh vừa tạo đã được hoàn tác.'
      );
    }

    return {
      generator,
      buttonCategory,
      blogCategory,
      createVoice,
      chatLog,
      actionLog
    };
  } catch (error) {
    for (
      const channel
      of created
    ) {
      if (
        channel &&
        guild.channels.cache.has(
          channel.id
        )
      ) {
        try {
          await channel.delete(
            `${BOT_NAME}: hoàn tác cài đặt lỗi`
          );
        } catch {
        }
      }
    }

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

  if (!session) {
    await tempFollowUp(
      interaction,
      '❌ Phiên thiết lập đã hết hạn. Hãy chạy lại `/setup`.',
      {
        error: true
      }
    );

    return;
  }

  if (
    !cleanDisplayName(
      session.displayName
    ) ||
    !isSnowflake(
      String(
        session.buttonCategoryId ||
        ''
      )
    ) ||
    !isSnowflake(
      String(
        session.blogCategoryId ||
        ''
      )
    )
  ) {
    await tempFollowUp(
      interaction,
      '❌ Hãy nhập tên Server và chọn đủ 2 danh mục trước khi cài đặt.',
      {
        error: true
      }
    );

    return;
  }

  const cooldown =
    useCooldown(
      interaction.user.id,
      `setup_install:${interaction.guild.id}`,
      5000
    );

  if (cooldown) {
    await tempFollowUp(
      interaction,
      '⏳ Vui lòng chờ một chút trước khi thao tác lại.',
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
      await tempFollowUp(
        interaction,
        '⚠️ Server đã có Voice HDK. Hãy chạy lại `/setup` và chọn **Cài đặt lại**.',
        {
          error: true
        }
      );

      return;
    }

    const installed =
      await installGuildSystem(
        interaction.guild,
        session
      );

    deleteSetupSession(
      interaction.guild.id,
      interaction.user.id
    );

    await interaction.editReply(
      buildSetupSuccessPanel({
        displayName:
          installed.generator.display_name,
        buttonCategoryId:
          installed.buttonCategory.id,
        blogCategoryId:
          installed.blogCategory.id,
        createVoiceId:
          installed.createVoice.id
      })
    );
  } catch (error) {
    logError(
      'SETUP_INSTALL',
      error
    );

    await tempFollowUp(
      interaction,
      `❌ Cài đặt thất bại: ${String(
        error?.message ||
        'Lỗi không xác định.'
      ).slice(
        0,
        1200
      )}`,
      {
        error: true
      }
    );
  }
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

  const ownerName =
    safeMemberName(
      owner
    );

  const memberCount =
    channel.members.filter(
      member =>
        !member.user.bot
    ).size;

  const limit =
    channel.userLimit > 0
      ? String(
          channel.userLimit
        )
      : '∞';

  const region =
    channel.rtcRegion
      ? cleanDisplayName(
          channel.rtcRegion
        )
      : 'Tự động';

  const displayName =
    cleanDisplayName(
      generator?.display_name
    ) ||
    'Voice HDK';

  return [
    '```',
    `🔊  PHÒNG CỦA ${ownerName.toUpperCase()}`,
    '────────────────────────────',
    `👑 Chủ phòng    ${ownerName}`,
    `👥 Thành viên   ${memberCount} / ${limit}`,
    `🔓 Phòng        ${state.locked ? 'Đang khóa' : 'Đang mở'}`,
    `👁 Hiển thị     ${state.hidden ? 'Đang ẩn' : 'Công khai'}`,
    `🌐 Khu vực      ${region}`,
    '────────────────────────────',
    `✦ ${BOT_NAME} • ${displayName}`,
    '```'
  ].join(
    '\n'
  );
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
            ButtonStyle.Secondary
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
            ButtonStyle.Secondary
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
            ButtonStyle.Secondary
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
            ButtonStyle.Primary
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
            ButtonStyle.Secondary
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
          'room_member'
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
    return 'Không xác định';
  }

  const name =
    cleanDisplayName(
      region.name
    ) ||
    cleanDisplayName(
      region.id
    );

  if (
    region.optimal
  ) {
    return `${name} • Tối ưu`;
  }

  return name;
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
      'BUILD_REGION_MENU',
      error
    );
  }

  const current =
    channel.rtcRegion
      ? String(
          channel.rtcRegion
        )
      : 'automatic';

  const options = [
    {
      label:
        'Tự động',
      value:
        'automatic',
      description:
        'Để Discord tự chọn khu vực',
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
        regionLabel(
          region
        ).slice(
          0,
          100
        ),
      value:
        region.id,
      description:
        region.optimal
          ? 'Discord đề xuất khu vực này'
          : 'Khu vực Voice Discord',
      default:
        current ===
        region.id
    });
  }

  if (
    current !==
      'automatic' &&
    !options.some(
      option =>
        option.value ===
        current
    )
  ) {
    if (
      options.length >=
      25
    ) {
      options.pop();
    }

    options.push({
      label:
        current.slice(
          0,
          100
        ),
      value:
        current,
      description:
        'Khu vực hiện tại',
      default:
        true
    });
  }

  return new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(
          'room_region'
        )
        .setPlaceholder(
          channel.rtcRegion
            ? `🌐 ${channel.rtcRegion}`
            : '🌐 Tự động'
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

async function buildRoomPanelPayload(
  channel,
  room
) {
  const generator =
    await getGenerator(
      channel.guild.id
    );

  const owner =
    await getRoomOwnerMember(
      room,
      channel.guild
    );

  const buttons =
    buildRoomButtons(
      channel
    );

  const memberSelect =
    buildMemberSelectRow();

  const regionSelect =
    await buildRegionSelectRow(
      channel
    );

  return {
    content:
      buildRoomDashboard(
        channel,
        owner,
        generator
      ),
    components: [
      ...buttons,
      memberSelect,
      regionSelect
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

  const customIds =
    [];

  for (
    const row
    of message.components || []
  ) {
    for (
      const component
      of row.components || []
    ) {
      const id =
        component.customId ||
        component.custom_id;

      if (id) {
        customIds.push(
          id
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
    !channel?.messages
  ) {
    return [];
  }

  try {
    const messages =
      await channel.messages.fetch({
        limit: 50
      });

    return messages
      .filter(
        message =>
          isRoomPanelMessage(
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
      `PANEL_SCAN:${channel.id}`,
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
    } catch (error) {
      logError(
        `PANEL_DUPLICATE_DELETE:${message.id}`,
        error
      );
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
        await deleteRoomRecord(
          channelId
        );

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

      if (!panelMessage) {
        panelMessage =
          discovered[0] ||
          null;
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
  channel,
  reason
) {
  if (
    !member ||
    !channel
  ) {
    throw new Error(
      'Không thể di chuyển thành viên.'
    );
  }

  if (
    member.voice?.channelId ===
    channel.id
  ) {
    return true;
  }

  await member.voice.setChannel(
    channel,
    reason
  );

  return true;
}

async function createPersonalVoiceRoom(
  guild,
  member,
  generator
) {
  const category =
    await getGuildChannel(
      guild,
      String(
        generator.button_category_id ||
        ''
      )
    );

  if (
    !category ||
    category.type !==
      ChannelType.GuildCategory
  ) {
    throw new Error(
      'Danh mục đặt nút không còn tồn tại.'
    );
  }

  const botMember =
    await getBotMember(
      guild
    );

  if (!botMember) {
    throw new Error(
      'Không tìm thấy bot trong server.'
    );
  }

  const roomName =
    `${ROOM_PREFIX}${cleanRoomName(
      safeMemberName(
        member
      )
    )}`.slice(
      0,
      100
    );

  let channel = null;

  try {
    channel =
      await guild.channels.create({
        name:
          roomName,
        type:
          ChannelType.GuildVoice,
        parent:
          category.id,
        userLimit:
          0,
        rtcRegion:
          null,
        reason:
          `${BOT_NAME}: tạo phòng tạm cho ${member.user.username}`,
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
              PermissionsBitField.Flags.ManageChannels,
              PermissionsBitField.Flags.ManageRoles,
              PermissionsBitField.Flags.MoveMembers
            ]
          }
        ]
      });

    await saveRoom({
      guildId:
        guild.id,
      channelId:
        channel.id,
      ownerId:
        member.id,
      categoryId:
        category.id
    });

    return channel;
  } catch (error) {
    if (channel) {
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
    }

    throw error;
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
    channel &&
    channel.type ===
      ChannelType.GuildVoice
  ) {
    return {
      room,
      channel
    };
  }

  await deleteRoomRecord(
    String(
      room.channel_id
    )
  );

  return null;
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
    member.user.bot
  ) {
    return;
  }

  const generator =
    await getGenerator(
      guild.id
    );

  if (
    !generator ||
    !generator.create_voice_id
  ) {
    return;
  }

  if (
    voiceState.channelId !==
    String(
      generator.create_voice_id
    )
  ) {
    return;
  }

  await withCreateLock(
    guild.id,
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
          guild,
          member.id
        );

      if (existing) {
        try {
          await moveMemberSafe(
            member,
            existing.channel,
            `${BOT_NAME}: chuyển về phòng hiện có`
          );

          await refreshRoomPanelSafe(
            existing.channel.id
          );
        } catch (error) {
          logError(
            `MOVE_EXISTING_ROOM:${member.id}`,
            error
          );
        }

        return;
      }

      let channel = null;

      try {
        channel =
          await createPersonalVoiceRoom(
            guild,
            member,
            generator
          );

        if (
          member.voice?.channelId !==
          String(
            generator.create_voice_id
          )
        ) {
          const humans =
            channel.members.filter(
              item =>
                !item.user.bot
            );

          if (
            humans.size === 0
          ) {
            await deleteRoomRecord(
              channel.id
            );

            await channel.delete(
              `${BOT_NAME}: người tạo đã rời trước khi hoàn tất`
            );
          }

          return;
        }

        await moveMemberSafe(
          member,
          channel,
          `${BOT_NAME}: chuyển vào phòng riêng`
        );

        await refreshRoomPanelSafe(
          channel.id
        );

        if (
          typeof sendActionLog ===
          'function'
        ) {
          await sendActionLog(
            guild,
            '➕',
            member,
            `Tạo phòng ${channel.name}`
          );
        }
      } catch (error) {
        logError(
          `CREATE_PERSONAL_ROOM:${member.id}`,
          error
        );

        if (channel) {
          try {
            const room =
              await getRoom(
                channel.id
              );

            if (
              room &&
              channel.members.filter(
                item =>
                  !item.user.bot
              ).size === 0
            ) {
              await deleteRoomRecord(
                channel.id
              );

              await channel.delete(
                `${BOT_NAME}: dọn phòng tạo lỗi`
              );
            }
          } catch {
          }
        }
      }
    }
  );
}

async function deleteEmptyRoom(
  channelId
) {
  clearEmptyRoomTimer(
    channelId
  );

  const room =
    await getRoom(
      channelId
    );

  if (!room) {
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

  if (!channel) {
    await deleteRoomRecord(
      channelId
    );

    return true;
  }

  if (
    channel.type !==
      ChannelType.GuildVoice
  ) {
    await deleteRoomRecord(
      channelId
    );

    return true;
  }

  const humans =
    channel.members.filter(
      member =>
        !member.user.bot
    );

  if (
    humans.size > 0
  ) {
    return false;
  }

  const roomName =
    channel.name;

  clearPendingTransfer(
    channel.id
  );

  clearSelectionsForChannel(
    guild.id,
    channel.id
  );

  try {
    await channel.delete(
      `${BOT_NAME}: phòng tạm không còn thành viên`
    );
  } catch (error) {
    logError(
      `DELETE_EMPTY_ROOM:${channel.id}`,
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
      `Xóa phòng ${roomName}`
    );
  }

  return true;
}

function scheduleEmptyRoomCheck(
  channelId,
  delay =
    EMPTY_ROOM_DELETE_DELAY_MS
) {
  const key =
    String(
      channelId
    );

  clearEmptyRoomTimer(
    key
  );

  const timer =
    setTimeout(
      () => {
        deleteEmptyRoom(
          key
        ).catch(
          error => {
            logError(
              `EMPTY_ROOM_CHECK:${key}`,
              error
            );
          }
        );
      },
      delay
    );

  timer.unref?.();

  emptyRoomTimers.set(
    key,
    timer
  );
}

async function refreshRoomAfterVoiceChange(
  channelId
) {
  if (
    !channelId
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
        channelId
      )
    );

  if (
    !channel ||
    channel.type !==
      ChannelType.GuildVoice
  ) {
    await deleteRoomRecord(
      channelId
    );

    return;
  }

  const humans =
    channel.members.filter(
      member =>
        !member.user.bot
    );

  if (
    humans.size === 0
  ) {
    scheduleEmptyRoomCheck(
      channel.id
    );

    return;
  }

  clearEmptyRoomTimer(
    channel.id
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
    !interaction.channel
  ) {
    return {
      ok: false,
      message:
        'Không tìm thấy phòng.'
    };
  }

  if (
    interaction.channel.type !==
    ChannelType.GuildVoice
  ) {
    return {
      ok: false,
      message:
        'Thao tác này chỉ dùng trong phòng Voice HDK.'
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
        'Phòng này không còn được Voice HDK quản lý.'
    };
  }

  if (
    String(
      room.guild_id
    ) !==
    interaction.guild.id
  ) {
    return {
      ok: false,
      message:
        'Dữ liệu phòng không hợp lệ.'
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
        'Chỉ chủ phòng mới có thể sử dụng chức năng này.'
    };
  }

  return {
    ok: true,
    room,
    channel:
      interaction.channel
  };
}

async function getRequiredSelectedMember(
  interaction,
  context
) {
  const member =
    await getSelectedMember(
      interaction.guild,
      context.channel.id,
      interaction.user.id
    );

  if (!member) {
    await tempFollowUp(
      interaction,
      '❌ Hãy chọn một thành viên ở mục **👤 Chọn thành viên** trước.',
      {
        error: true
      }
    );

    return null;
  }

  if (
    member.id ===
    interaction.user.id
  ) {
    await tempFollowUp(
      interaction,
      '❌ Bạn không thể chọn chính mình cho thao tác này.',
      {
        error: true
      }
    );

    return null;
  }

  if (
    member.user.bot
  ) {
    await tempFollowUp(
      interaction,
      '❌ Không thể áp dụng thao tác này cho bot.',
      {
        error: true
      }
    );

    return null;
  }

  return member;
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
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const memberId =
    String(
      interaction.values?.[0] ||
      ''
    );

  const member =
    await getGuildMember(
      interaction.guild,
      memberId
    );

  if (
    !member ||
    member.user.bot
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

  setSelectedMember(
    interaction.guild.id,
    context.channel.id,
    interaction.user.id,
    member.id
  );
}

async function handleRoomLock(
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
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const cooldown =
    useCooldown(
      interaction.user.id,
      `lock:${context.channel.id}`
    );

  if (cooldown) {
    await tempFollowUp(
      interaction,
      '⏳ Bạn thao tác quá nhanh.',
      {
        error: true
      }
    );

    return;
  }

  try {
    const current =
      getRoomState(
        context.channel
      );

    const nextLocked =
      !current.locked;

    await setRoomLocked(
      context.channel,
      nextLocked
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    if (
      typeof sendActionLog ===
      'function'
    ) {
      await sendActionLog(
        interaction.guild,
        nextLocked
          ? '🔒'
          : '🔓',
        interaction.member,
        `${nextLocked ? 'Khóa' : 'Mở'} phòng ${context.channel.name}`
      );
    }

    await tempFollowUp(
      interaction,
      nextLocked
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
      '❌ Không thể thay đổi trạng thái khóa của phòng.',
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

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempFollowUp(
      interaction,
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const cooldown =
    useCooldown(
      interaction.user.id,
      `hide:${context.channel.id}`
    );

  if (cooldown) {
    await tempFollowUp(
      interaction,
      '⏳ Bạn thao tác quá nhanh.',
      {
        error: true
      }
    );

    return;
  }

  try {
    const current =
      getRoomState(
        context.channel
      );

    const nextHidden =
      !current.hidden;

    await setRoomHidden(
      context.channel,
      nextHidden
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    if (
      typeof sendActionLog ===
      'function'
    ) {
      await sendActionLog(
        interaction.guild,
        nextHidden
          ? '🙈'
          : '👁️',
        interaction.member,
        `${nextHidden ? 'Ẩn' : 'Hiện'} phòng ${context.channel.name}`
      );
    }

    await tempFollowUp(
      interaction,
      nextHidden
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
      '❌ Không thể thay đổi trạng thái hiển thị của phòng.',
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
    await interaction.reply({
      content:
        `❌ ${context.message}`,
      ephemeral: true
    }).catch(
      () => {}
    );

    deleteReplyLater(
      interaction,
      ERROR_DELETE_MS
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

  const input =
    new TextInputBuilder()
      .setCustomId(
        'room_name'
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
      .setMinLength(
        1
      )
      .setMaxLength(
        80
      )
      .setRequired(
        true
      );

  let currentName =
    String(
      context.channel.name ||
      ''
    );

  if (
    currentName.startsWith(
      ROOM_PREFIX
    )
  ) {
    currentName =
      currentName.slice(
        ROOM_PREFIX.length
      );
  }

  currentName =
    cleanRoomName(
      currentName
    );

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

  await interaction.showModal(
    modal
  );
}

async function handleRoomRenameModal(
  interaction
) {
  await safeDeferReply(
    interaction,
    true
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempReply(
      interaction,
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const cooldown =
    useCooldown(
      interaction.user.id,
      `rename:${context.channel.id}`,
      3000
    );

  if (cooldown) {
    await tempReply(
      interaction,
      '⏳ Vui lòng chờ một chút trước khi đổi tên tiếp.',
      {
        error: true
      }
    );

    return;
  }

  const rawName =
    interaction.fields.getTextInputValue(
      'room_name'
    );

  const cleaned =
    cleanRoomName(
      rawName
    );

  if (!cleaned) {
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
    `${ROOM_PREFIX}${cleaned}`.slice(
      0,
      100
    );

  try {
    await context.channel.setName(
      newName,
      `${BOT_NAME}: chủ phòng đổi tên`
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    if (
      typeof sendActionLog ===
      'function'
    ) {
      await sendActionLog(
        interaction.guild,
        '✏️',
        interaction.member,
        `Đổi tên phòng thành ${newName}`
      );
    }

    await tempReply(
      interaction,
      `✏️ Đã đổi tên phòng thành **${newName}**.`
    );
  } catch (error) {
    logError(
      'ROOM_RENAME',
      error
    );

    await tempReply(
      interaction,
      '❌ Không thể đổi tên phòng lúc này.',
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
    await interaction.reply({
      content:
        `❌ ${context.message}`,
      ephemeral: true
    }).catch(
      () => {}
    );

    deleteReplyLater(
      interaction,
      ERROR_DELETE_MS
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
        'room_limit_value'
      )
      .setLabel(
        'Số người tối đa'
      )
      .setPlaceholder(
        'Nhập 0 để không giới hạn'
      )
      .setStyle(
        TextInputStyle.Short
      )
      .setMinLength(
        1
      )
      .setMaxLength(
        2
      )
      .setRequired(
        true
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
    true
  );

  const context =
    await getOwnerRoomContext(
      interaction
    );

  if (!context.ok) {
    await tempReply(
      interaction,
      `❌ ${context.message}`,
      {
        error: true
      }
    );

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
    await tempReply(
      interaction,
      '❌ Giới hạn phải là số từ **0 đến 99**.',
      {
        error: true
      }
    );

    return;
  }

  const limit =
    Number(
      raw
    );

  if (
    !Number.isInteger(
      limit
    ) ||
    limit < 0 ||
    limit > 99
  ) {
    await tempReply(
      interaction,
      '❌ Giới hạn phải là số từ **0 đến 99**.',
      {
        error: true
      }
    );

    return;
  }

  const cooldown =
    useCooldown(
      interaction.user.id,
      `limit:${context.channel.id}`
    );

  if (cooldown) {
    await tempReply(
      interaction,
      '⏳ Bạn thao tác quá nhanh.',
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

    if (
      typeof sendActionLog ===
      'function'
    ) {
      await sendActionLog(
        interaction.guild,
        '👥',
        interaction.member,
        `Giới hạn phòng: ${
          limit === 0
            ? 'Không giới hạn'
            : `${limit} người`
        }`
      );
    }

    await tempReply(
      interaction,
      limit === 0
        ? '👥 Đã bỏ giới hạn số người.'
        : `👥 Đã đặt giới hạn **${limit} người**.`
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
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const member =
    await getRequiredSelectedMember(
      interaction,
      context
    );

  if (!member) {
    return;
  }

  const cooldown =
    useCooldown(
      interaction.user.id,
      `invite:${context.channel.id}`
    );

  if (cooldown) {
    await tempFollowUp(
      interaction,
      '⏳ Bạn thao tác quá nhanh.',
      {
        error: true
      }
    );

    return;
  }

  try {
    await inviteMemberToRoom(
      context.channel,
      member
    );

    clearSelectedMember(
      interaction.guild.id,
      context.channel.id,
      interaction.user.id
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    if (
      typeof sendActionLog ===
      'function'
    ) {
      await sendActionLog(
        interaction.guild,
        '✉️',
        interaction.member,
        `Mời ${safeMemberName(member)} vào phòng`
      );
    }

    await tempFollowUp(
      interaction,
      `✉️ Đã cấp quyền vào phòng cho **${safeMemberName(
        member
      )}**.`
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
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const member =
    await getRequiredSelectedMember(
      interaction,
      context
    );

  if (!member) {
    return;
  }

  const cooldown =
    useCooldown(
      interaction.user.id,
      `deny:${context.channel.id}`
    );

  if (cooldown) {
    await tempFollowUp(
      interaction,
      '⏳ Bạn thao tác quá nhanh.',
      {
        error: true
      }
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
      interaction.user.id
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    if (
      typeof sendActionLog ===
      'function'
    ) {
      await sendActionLog(
        interaction.guild,
        '⛔',
        interaction.member,
        `Cấm ${safeMemberName(member)} khỏi phòng`
      );
    }

    await tempFollowUp(
      interaction,
      `⛔ Đã cấm **${safeMemberName(
        member
      )}** khỏi phòng.`
    );
  } catch (error) {
    logError(
      'ROOM_DENY',
      error
    );

    await tempFollowUp(
      interaction,
      '❌ Không thể cấm thành viên khỏi phòng.',
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
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const member =
    await getRequiredSelectedMember(
      interaction,
      context
    );

  if (!member) {
    return;
  }

  if (
    member.voice?.channelId !==
    context.channel.id
  ) {
    await tempFollowUp(
      interaction,
      '❌ Thành viên được chọn không còn ở trong phòng này.',
      {
        error: true
      }
    );

    return;
  }

  const cooldown =
    useCooldown(
      interaction.user.id,
      `kick:${context.channel.id}`
    );

  if (cooldown) {
    await tempFollowUp(
      interaction,
      '⏳ Bạn thao tác quá nhanh.',
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
      interaction.user.id
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    if (
      typeof sendActionLog ===
      'function'
    ) {
      await sendActionLog(
        interaction.guild,
        '👢',
        interaction.member,
        `Đuổi ${safeMemberName(member)} khỏi phòng`
      );
    }

    await tempFollowUp(
      interaction,
      `👢 Đã đuổi **${safeMemberName(
        member
      )}** khỏi phòng.`
    );
  } catch (error) {
    logError(
      'ROOM_KICK',
      error
    );

    await tempFollowUp(
      interaction,
      String(
        error?.message ||
        '❌ Không thể đuổi thành viên khỏi phòng.'
      ).startsWith(
        'Thành viên'
      )
        ? `❌ ${error.message}`
        : '❌ Không thể đuổi thành viên khỏi phòng.',
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
          '🧹 Xóa quyền Mời/Cấm riêng của thành viên',
          '',
          '**Phòng và chủ phòng sẽ không bị xóa.**'
        ].join(
          '\n'
        )
      );

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'room_reset_confirm'
          )
          .setLabel(
            'Đặt lại'
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
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  try {
    const message =
      await interaction.followUp({
        ...buildResetConfirmation(),
        ephemeral: true,
        fetchReply: true
      });

    const timer =
      setTimeout(
        async () => {
          try {
            await message.delete();
          } catch {
          }
        },
        30000
      );

    timer.unref?.();
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
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const cooldown =
    useCooldown(
      interaction.user.id,
      `reset:${context.channel.id}`,
      3000
    );

  if (cooldown) {
    await tempFollowUp(
      interaction,
      '⏳ Bạn thao tác quá nhanh.',
      {
        error: true
      }
    );

    return;
  }

  try {
    await resetRoomState(
      context.channel,
      context.room.owner_id
    );

    clearSelectedMember(
      interaction.guild.id,
      context.channel.id,
      interaction.user.id
    );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    try {
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
    } catch {
      await tempFollowUp(
        interaction,
        '♻️ Đã đặt lại phòng.'
      );
    }

    if (
      typeof sendActionLog ===
      'function'
    ) {
      await sendActionLog(
        interaction.guild,
        '♻️',
        interaction.member,
        `Đặt lại phòng ${context.channel.name}`
      );
    }
  } catch (error) {
    logError(
      'ROOM_RESET',
      error
    );

    await tempFollowUp(
      interaction,
      '❌ Không thể đặt lại phòng.',
      {
        error: true
      }
    );
  }
}

async function handleRoomResetCancel(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  try {
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
  } catch {
  }
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
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const selected =
    String(
      interaction.values?.[0] ||
      ''
    );

  if (!selected) {
    await tempFollowUp(
      interaction,
      '❌ Khu vực được chọn không hợp lệ.',
      {
        error: true
      }
    );

    return;
  }

  const cooldown =
    useCooldown(
      interaction.user.id,
      `region:${context.channel.id}`,
      3000
    );

  if (cooldown) {
    await tempFollowUp(
      interaction,
      '⏳ Bạn thao tác quá nhanh.',
      {
        error: true
      }
    );

    return;
  }

  try {
    let region = null;

    if (
      selected !==
      'automatic'
    ) {
      region =
        await validateVoiceRegion(
          selected
        );

      if (!region) {
        await tempFollowUp(
          interaction,
          '❌ Khu vực này không còn khả dụng. Danh sách khu vực đã được làm mới.',
          {
            error: true
          }
        );

        await refreshRoomPanelSafe(
          context.channel.id
        );

        return;
      }
    }

    await context.channel.setRTCRegion(
      selected ===
        'automatic'
        ? null
        : region.id,
      `${BOT_NAME}: đổi khu vực Voice`
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
        'Không thể xác minh phòng sau khi đổi khu vực.'
      );
    }

    if (
      selected ===
        'automatic'
    ) {
      if (
        verified.rtcRegion !==
        null
      ) {
        await verified.setRTCRegion(
          null,
          `${BOT_NAME}: xác nhận khu vực tự động`
        );
      }
    } else if (
      verified.rtcRegion !==
      region.id
    ) {
      const freshRegion =
        await validateVoiceRegion(
          region.id
        );

      if (!freshRegion) {
        throw new Error(
          'Khu vực vừa chọn không còn khả dụng.'
        );
      }

      await verified.setRTCRegion(
        freshRegion.id,
        `${BOT_NAME}: xác nhận khu vực Voice`
      );
    }

    verified =
      await getGuildChannel(
        interaction.guild,
        context.channel.id
      );

    await refreshRoomPanelSafe(
      context.channel.id
    );

    const label =
      selected ===
        'automatic'
        ? 'Tự động'
        : (
            region?.name ||
            region?.id ||
            selected
          );

    if (
      typeof sendActionLog ===
      'function'
    ) {
      await sendActionLog(
        interaction.guild,
        '🌐',
        interaction.member,
        `Đổi khu vực: ${label}`
      );
    }

    await tempFollowUp(
      interaction,
      `🌐 Đã đổi khu vực thành **${label}**.`
    );
  } catch (error) {
    logError(
      'ROOM_REGION',
      error
    );

    await tempFollowUp(
      interaction,
      `❌ Không thể đổi khu vực Voice: ${String(
        error?.message ||
        'Lỗi không xác định.'
      ).slice(
        0,
        500
      )}`,
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
      `❌ ${context.message}`,
      {
        error: true
      }
    );

    return;
  }

  const member =
    await getRequiredSelectedMember(
      interaction,
      context
    );

  if (!member) {
    return;
  }

  if (
    member.voice?.channelId !==
    context.channel.id
  ) {
    await tempFollowUp(
      interaction,
      '❌ Người nhận quyền chủ phải đang ở trong phòng này.',
      {
        error: true
      }
    );

    return;
  }

  if (
    getPendingTransfer(
      context.channel.id
    )
  ) {
    await tempFollowUp(
      interaction,
      '⚠️ Phòng đang có một yêu cầu chuyển chủ chưa kết thúc.',
      {
        error: true
      }
    );

    return;
  }

  const cooldown =
    useCooldown(
      interaction.user.id,
      `transfer:${context.channel.id}`,
      3000
    );

  if (cooldown) {
    await tempFollowUp(
      interaction,
      '⏳ Bạn thao tác quá nhanh.',
      {
        error: true
      }
    );

    return;
  }

  clearSelectedMember(
    interaction.guild.id,
    context.channel.id,
    interaction.user.id
  );

  try {
    await createTransferRequest(
      interaction,
      context,
      member
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
  if (
    typeof actor ===
    'string'
  ) {
    return cleanDisplayName(
      actor
    ) || BOT_NAME;
  }

  return safeMemberName(
    actor
  );
}

async function sendActionLog(
  guild,
  emoji,
  actor,
  action
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

    const actorName =
      actionActorName(
        actor
      );

    const text =
      `${emoji} ${actorName} » ${String(
        action || ''
      ).slice(
        0,
        1500
      )} • ${vietnamTime()}`;

    return await channel.send({
      content:
        text.slice(
          0,
          2000
        ),
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

function buildTransferRequestPayload(
  owner,
  target,
  expiresAt
) {
  const ownerName =
    safeMemberName(
      owner
    );

  const targetName =
    safeMemberName(
      target
    );

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
            ButtonStyle.Secondary
          )
      );

  return {
    content: [
      `👑 **${ownerName}** muốn chuyển quyền chủ phòng cho <@${target.id}>`,
      `⏳ Hết hạn ${relativeTimestamp(
        expiresAt
      )}`
    ].join(
      '\n'
    ),
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

  try {
    const guild =
      client.guilds.cache.get(
        transfer.guildId
      );

    if (!guild) {
      return;
    }

    const channel =
      await getGuildChannel(
        guild,
        transfer.channelId
      );

    if (
      !channel ||
      !channel.messages
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

    await message.edit({
      content:
        '⌛ Yêu cầu chuyển chủ đã hết hạn.',
      components: [],
      allowedMentions: {
        parse: []
      }
    });

    deleteMessageLater(
      message,
      SUCCESS_DELETE_MS
    );
  } catch (error) {
    logError(
      'TRANSFER_EXPIRE',
      error
    );
  }
}

async function createTransferRequest(
  interaction,
  context,
  target
) {
  if (
    !interaction.guild ||
    !context?.channel ||
    !context?.room ||
    !target
  ) {
    throw new Error(
      'Yêu cầu chuyển chủ không hợp lệ.'
    );
  }

  const owner =
    await getGuildMember(
      interaction.guild,
      String(
        context.room.owner_id
      )
    );

  if (!owner) {
    throw new Error(
      'Không tìm thấy chủ phòng hiện tại.'
    );
  }

  if (
    owner.id !==
    interaction.user.id
  ) {
    throw new Error(
      'Bạn không còn là chủ phòng.'
    );
  }

  if (
    target.id ===
    owner.id
  ) {
    throw new Error(
      'Không thể chuyển chủ cho chính mình.'
    );
  }

  if (
    target.user.bot
  ) {
    throw new Error(
      'Không thể chuyển chủ cho bot.'
    );
  }

  if (
    target.voice?.channelId !==
    context.channel.id
  ) {
    throw new Error(
      'Người nhận phải đang ở trong phòng.'
    );
  }

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
    throw new Error(
      'Người được chọn đang sở hữu một phòng khác.'
    );
  }

  const expiresAt =
    Date.now() +
    TRANSFER_TIMEOUT_MS;

  const message =
    await context.channel.send(
      buildTransferRequestPayload(
        owner,
        target,
        expiresAt
      )
    );

  const key =
    transferKey(
      context.channel.id
    );

  const timer =
    setTimeout(
      () => {
        expireTransferRequest(
          context.channel.id
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

  pendingTransfers.set(
    key,
    {
      guildId:
        interaction.guild.id,
      channelId:
        context.channel.id,
      messageId:
        message.id,
      ownerId:
        owner.id,
      targetId:
        target.id,
      expiresAt,
      timer
    }
  );

  await tempFollowUp(
    interaction,
    `👑 Đã gửi yêu cầu chuyển chủ cho **${safeMemberName(
      target
    )}**.`
  );
}

async function editTransferResult(
  interaction,
  content
) {
  try {
    await interaction.editReply({
      content,
      components: [],
      allowedMentions: {
        parse: []
      }
    });

    deleteReplyLater(
      interaction,
      SUCCESS_DELETE_MS
    );
  } catch (error) {
    logError(
      'TRANSFER_RESULT_EDIT',
      error
    );
  }
}

async function handleTransferAccept(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  if (
    !interaction.guild ||
    !interaction.channel
  ) {
    await tempFollowUp(
      interaction,
      '❌ Không tìm thấy phòng.',
      {
        error: true
      }
    );

    return;
  }

  const transfer =
    getPendingTransfer(
      interaction.channel.id
    );

  if (!transfer) {
    await editTransferResult(
      interaction,
      '⌛ Yêu cầu chuyển chủ đã hết hạn.'
    );

    return;
  }

  if (
    interaction.user.id !==
    transfer.targetId
  ) {
    await tempFollowUp(
      interaction,
      '❌ Chỉ người được yêu cầu mới có thể đồng ý.',
      {
        error: true
      }
    );

    return;
  }

  try {
    const room =
      await getRoom(
        interaction.channel.id
      );

    if (!room) {
      clearPendingTransfer(
        interaction.channel.id
      );

      await editTransferResult(
        interaction,
        '❌ Phòng này không còn được Voice HDK quản lý.'
      );

      return;
    }

    if (
      String(
        room.owner_id
      ) !==
      transfer.ownerId
    ) {
      clearPendingTransfer(
        interaction.channel.id
      );

      await editTransferResult(
        interaction,
        '⚠️ Chủ phòng đã thay đổi. Yêu cầu chuyển chủ này không còn hiệu lực.'
      );

      return;
    }

    const oldOwner =
      await getGuildMember(
        interaction.guild,
        transfer.ownerId
      );

    const newOwner =
      await getGuildMember(
        interaction.guild,
        transfer.targetId
      );

    if (!newOwner) {
      clearPendingTransfer(
        interaction.channel.id
      );

      await editTransferResult(
        interaction,
        '❌ Không tìm thấy người nhận quyền chủ.'
      );

      return;
    }

    if (
      newOwner.voice?.channelId !==
      interaction.channel.id
    ) {
      clearPendingTransfer(
        interaction.channel.id
      );

      await editTransferResult(
        interaction,
        '❌ Người nhận đã rời khỏi phòng. Chuyển chủ đã hủy.'
      );

      return;
    }

    if (
      oldOwner &&
      oldOwner.voice?.channelId !==
        interaction.channel.id
    ) {
      clearPendingTransfer(
        interaction.channel.id
      );

      await editTransferResult(
        interaction,
        '❌ Chủ phòng hiện tại đã rời khỏi phòng. Chuyển chủ đã hủy.'
      );

      return;
    }

    const existingOwned =
      await getOwnedRoom(
        interaction.guild.id,
        newOwner.id
      );

    if (
      existingOwned &&
      String(
        existingOwned.channel_id
      ) !==
      interaction.channel.id
    ) {
      clearPendingTransfer(
        interaction.channel.id
      );

      await editTransferResult(
        interaction,
        '❌ Người nhận đang sở hữu một phòng khác.'
      );

      return;
    }

    const dbClient =
      await pool.connect();

    let dbUpdated =
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
            interaction.channel.id
          ]
        );

      const current =
        lockedRoom.rows[0];

      if (!current) {
        throw new Error(
          'ROOM_NOT_FOUND'
        );
      }

      if (
        String(
          current.owner_id
        ) !==
        transfer.ownerId
      ) {
        throw new Error(
          'OWNER_CHANGED'
        );
      }

      const otherRoom =
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
            newOwner.id,
            interaction.channel.id
          ]
        );

      if (
        otherRoom.rowCount >
        0
      ) {
        throw new Error(
          'TARGET_HAS_ROOM'
        );
      }

      await updateRoomOwner(
        interaction.channel.id,
        newOwner.id,
        dbClient
      );

      await dbClient.query(
        'COMMIT'
      );

      dbUpdated =
        true;
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
        interaction.channel,
        newOwner.id
      );

      if (
        oldOwner &&
        oldOwner.id !==
        newOwner.id
      ) {
        await removeOwnerPermissions(
          interaction.channel,
          oldOwner.id
        );
      }

      await ensureBotRoomPermissions(
        interaction.channel
      );
    } catch (permissionError) {
      logError(
        'TRANSFER_PERMISSION_UPDATE',
        permissionError
      );

      if (dbUpdated) {
        try {
          await updateRoomOwner(
            interaction.channel.id,
            transfer.ownerId
          );

          if (oldOwner) {
            await grantOwnerPermissions(
              interaction.channel,
              oldOwner.id
            );
          }

          await safeDeleteOverwrite(
            interaction.channel,
            newOwner.id,
            `${BOT_NAME}: hoàn tác chuyển chủ lỗi`
          );
        } catch (rollbackError) {
          logError(
            'TRANSFER_PERMISSION_ROLLBACK',
            rollbackError
          );
        }
      }

      throw new Error(
        'Không thể cập nhật quyền cho chủ phòng mới.'
      );
    }

    clearPendingTransfer(
      interaction.channel.id
    );

    clearSelectionsForChannel(
      interaction.guild.id,
      interaction.channel.id
    );

    await refreshRoomPanelSafe(
      interaction.channel.id
    );

    await editTransferResult(
      interaction,
      `👑 **${safeMemberName(
        newOwner
      )}** đã trở thành chủ phòng.`
    );

    await sendActionLog(
      interaction.guild,
      '👑',
      oldOwner ||
        transfer.ownerId,
      `Chuyển chủ cho ${safeMemberName(
        newOwner
      )}`
    );
  } catch (error) {
    logError(
      'TRANSFER_ACCEPT',
      error
    );

    let message =
      '❌ Không thể hoàn tất chuyển chủ.';

    if (
      error?.message ===
      'TARGET_HAS_ROOM'
    ) {
      message =
        '❌ Người nhận đang sở hữu một phòng khác.';
    }

    if (
      error?.message ===
      'OWNER_CHANGED'
    ) {
      message =
        '⚠️ Chủ phòng đã thay đổi. Yêu cầu này không còn hiệu lực.';
    }

    clearPendingTransfer(
      interaction.channel.id
    );

    await editTransferResult(
      interaction,
      message
    );
  }
}

async function handleTransferDecline(
  interaction
) {
  await safeDeferUpdate(
    interaction
  );

  if (
    !interaction.channel
  ) {
    return;
  }

  const transfer =
    getPendingTransfer(
      interaction.channel.id
    );

  if (!transfer) {
    await editTransferResult(
      interaction,
      '⌛ Yêu cầu chuyển chủ đã hết hạn.'
    );

    return;
  }

  if (
    interaction.user.id !==
    transfer.targetId
  ) {
    await tempFollowUp(
      interaction,
      '❌ Chỉ người được yêu cầu mới có thể từ chối.',
      {
        error: true
      }
    );

    return;
  }

  clearPendingTransfer(
    interaction.channel.id
  );

  await editTransferResult(
    interaction,
    '✖️ Yêu cầu chuyển chủ đã bị từ chối.'
  );
}

function compactLogText(
  value,
  maxLength = 1000
) {
  const text =
    String(
      value || ''
    )
      .replace(
        /\r/g,
        ''
      )
      .replace(
        /\n+/g,
        ' ↵ '
      )
      .replace(
        /\s+/g,
        ' '
      )
      .trim();

  if (!text) {
    return '';
  }

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

function escapeLogQuote(
  value,
  maxLength = 1000
) {
  return compactLogText(
    value,
    maxLength
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
    ) || [];

  return [
    ...new Set(
      matches.map(
        url =>
          url.replace(
            /[),.!?]+$/g,
            ''
          )
      )
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
    attachments.size === 0
  ) {
    return [];
  }

  return [
    ...attachments.values()
  ].map(
    attachment => ({
      id:
        attachment.id,
      name:
        compactLogText(
          attachment.name ||
          'tep-dinh-kem',
          120
        ),
      url:
        attachment.url,
      proxyURL:
        attachment.proxyURL,
      size:
        Number(
          attachment.size || 0
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

async function downloadAttachmentBuffer(
  attachment
) {
  if (
    !attachment?.url
  ) {
    throw new Error(
      'Attachment URL không hợp lệ.'
    );
  }

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => {
        controller.abort();
      },
      15000
    );

  timer.unref?.();

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
        `HTTP ${response.status}`
      );
    }

    const arrayBuffer =
      await response.arrayBuffer();

    return Buffer.from(
      arrayBuffer
    );
  } finally {
    clearTimeout(
      timer
    );
  }
}

async function archiveAttachments(
  logChannel,
  attachments
) {
  const archivedFiles = [];
  const metadata = [];
  const warnings = [];

  if (
    !attachments?.length
  ) {
    return {
      archivedFiles,
      metadata,
      warnings
    };
  }

  let uploadLimit =
    Number(
      logChannel.guild
        ?.maximumBitrate
    );

  uploadLimit =
    Number(
      logChannel.guild
        ?.premiumTier
    ) >= 2
      ? 50 * 1024 * 1024
      : 10 * 1024 * 1024;

  for (
    const attachment
    of attachments
  ) {
    metadata.push(
      `${attachment.name} (${Math.max(
        1,
        Math.ceil(
          attachment.size /
          1024
        )
      )} KB)`
    );

    if (
      attachment.size >
      uploadLimit
    ) {
      warnings.push(
        `⚠️ Không thể lưu bản sao ${attachment.name}: tệp quá lớn. URL gốc: ${attachment.url}`
      );

      continue;
    }

    try {
      const buffer =
        await downloadAttachmentBuffer(
          attachment
        );

      if (
        buffer.length >
        uploadLimit
      ) {
        warnings.push(
          `⚠️ Không thể lưu bản sao ${attachment.name}: tệp vượt giới hạn upload. URL gốc: ${attachment.url}`
        );

        continue;
      }

      archivedFiles.push({
        attachment:
          buffer,
        name:
          attachment.name
      });
    } catch (error) {
      logError(
        `ARCHIVE_ATTACHMENT:${attachment.id}`,
        error
      );

      warnings.push(
        `⚠️ Không thể lưu bản sao ${attachment.name}. URL gốc: ${attachment.url}`
      );
    }
  }

  return {
    archivedFiles,
    metadata,
    warnings
  };
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

  return (
    cleanDisplayName(
      message?.author?.globalName
    ) ||
    cleanDisplayName(
      message?.author?.username
    ) ||
    'Không xác định'
  );
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

  if (
    !logChannel ||
    logChannel.id ===
      message.channelId
  ) {
    return;
  }

  const author =
    messageAuthorName(
      message
    );

  const content =
    escapeLogQuote(
      message.content,
      900
    );

  const urls =
    extractUrls(
      message.content
    );

  const attachments =
    attachmentSummary(
      message.attachments
    );

  const archived =
    await archiveAttachments(
      logChannel,
      attachments
    );

  const lines = [];

  lines.push(
    content
      ? `💬 ${author} » "${content}"`
      : `💬 ${author} » Gửi tin nhắn`
  );

  if (
    urls.length > 0
  ) {
    lines.push(
      `🔗 Liên kết: ${urls.join(
        ' • '
      )}`.slice(
        0,
        1800
      )
    );
  }

  if (
    archived.metadata.length >
    0
  ) {
    lines.push(
      `📎 Tệp đính kèm: ${archived.metadata.join(
        ' • '
      )}`.slice(
        0,
        1800
      )
    );
  }

  for (
    const warning
    of archived.warnings
  ) {
    lines.push(
      warning.slice(
        0,
        1800
      )
    );
  }

  lines.push(
    vietnamTime(
      message.createdAt ||
      new Date()
    )
  );

  const payload = {
    content:
      lines.join(
        '\n'
      ).slice(
        0,
        2000
      ),
    allowedMentions: {
      parse: []
    }
  };

  if (
    archived.archivedFiles.length >
    0
  ) {
    payload.files =
      archived.archivedFiles;
  }

  try {
    await logChannel.send(
      payload
    );
  } catch (error) {
    logError(
      'CHAT_CREATE_LOG_WITH_FILES',
      error
    );

    try {
      const fallbackLines =
        [
          ...lines,
          ...attachments.map(
            attachment =>
              `📎 URL gốc: ${attachment.url}`
          )
        ];

      await logChannel.send({
        content:
          fallbackLines.join(
            '\n'
          ).slice(
            0,
            2000
          ),
        allowedMentions: {
          parse: []
        }
      });
    } catch (fallbackError) {
      logError(
        'CHAT_CREATE_LOG_FALLBACK',
        fallbackError
      );
    }
  }
}

async function hydratePartialMessage(
  message
) {
  if (!message) {
    return message;
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

  oldMessage =
    await hydratePartialMessage(
      oldMessage
    );

  const message =
    newMessage ||
    oldMessage;

  if (
    !message?.guild ||
    message.author?.bot
  ) {
    return;
  }

  const before =
    escapeLogQuote(
      oldMessage?.content,
      700
    );

  const after =
    escapeLogQuote(
      newMessage?.content,
      700
    );

  if (
    before === after
  ) {
    return;
  }

  const logChannel =
    await getChatLogChannel(
      message.guild
    );

  if (
    !logChannel ||
    logChannel.id ===
      message.channelId
  ) {
    return;
  }

  const author =
    messageAuthorName(
      message
    );

  const lines = [
    `✏️ ${author} » Chỉnh sửa tin nhắn`,
    `Trước: "${before || '(trống)'}"`,
    `Sau: "${after || '(trống)'}"`,
    vietnamTime()
  ];

  await logChannel.send({
    content:
      lines.join(
        '\n'
      ).slice(
        0,
        2000
      ),
    allowedMentions: {
      parse: []
    }
  });
}

async function sendChatDeleteLog(
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

  const logChannel =
    await getChatLogChannel(
      message.guild
    );

  if (
    !logChannel ||
    logChannel.id ===
      message.channelId
  ) {
    return;
  }

  const author =
    messageAuthorName(
      message
    );

  const content =
    escapeLogQuote(
      message.content,
      1000
    );

  const attachments =
    attachmentSummary(
      message.attachments
    );

  const lines = [
    content
      ? `🗑️ ${author} » Đã xóa "${content}"`
      : `🗑️ ${author} » Đã xóa tin nhắn`
  ];

  if (
    attachments.length >
    0
  ) {
    lines.push(
      `📎 Tệp trong tin nhắn: ${attachments
        .map(
          attachment =>
            attachment.name
        )
        .join(
          ' • '
        )}`.slice(
        0,
        1800
      )
    );
  }

  lines.push(
    vietnamTime()
  );

  await logChannel.send({
    content:
      lines.join(
        '\n'
      ).slice(
        0,
        2000
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
    !channel?.guild ||
    !messages?.size
  ) {
    return;
  }

  const logChannel =
    await getChatLogChannel(
      channel.guild
    );

  if (
    !logChannel ||
    logChannel.id ===
      channel.id
  ) {
    return;
  }

  const count =
    messages.filter(
      message =>
        !message.author?.bot
    ).size;

  if (
    count <= 0
  ) {
    return;
  }

  await logChannel.send({
    content:
      `🗑️ Voice HDK » ${count} tin nhắn đã bị xóa hàng loạt trong <#${channel.id}> • ${vietnamTime()}`,
    allowedMentions: {
      parse: []
    }
  });
}
const slashCommands = [
  new SlashCommandBuilder()
    .setName(
      'setup'
    )
    .setDescription(
      'Cài đặt hoặc cài đặt lại Voice HDK'
    )
    .setDMPermission(
      false
    ),

  new SlashCommandBuilder()
    .setName(
      'panel'
    )
    .setDescription(
      'Khôi phục bảng điều khiển phòng Voice HDK'
    )
    .setDMPermission(
      false
    ),

  new SlashCommandBuilder()
    .setName(
      'claim'
    )
    .setDescription(
      'Nhận quyền chủ phòng khi chủ cũ không còn trong phòng'
    )
    .setDMPermission(
      false
    ),

  new SlashCommandBuilder()
    .setName(
      'doctor'
    )
    .setDescription(
      'Kiểm tra trạng thái hệ thống Voice HDK'
    )
    .setDMPermission(
      false
    )
].map(
  command =>
    command.toJSON()
);

async function registerSlashCommands() {
  await client.application.commands.set(
    slashCommands
  );

  console.log(
    `[${BOT_NAME}] Đã đăng ký Slash Commands.`
  );
}

async function handlePanelCommand(
  interaction
) {
  await safeDeferReply(
    interaction,
    true
  );

  if (
    !interaction.guild ||
    !interaction.channel
  ) {
    await tempReply(
      interaction,
      '❌ Lệnh này chỉ sử dụng trong phòng Voice HDK.',
      {
        error: true
      }
    );

    return;
  }

  if (
    interaction.channel.type !==
    ChannelType.GuildVoice
  ) {
    await tempReply(
      interaction,
      '❌ Hãy sử dụng `/panel` trong phòng Voice HDK cần khôi phục.',
      {
        error: true
      }
    );

    return;
  }

  try {
    const room =
      await getRoom(
        interaction.channel.id
      );

    if (!room) {
      await tempReply(
        interaction,
        '❌ Phòng này không được Voice HDK quản lý.',
        {
          error: true
        }
      );

      return;
    }

    const isOwner =
      String(
        room.owner_id
      ) ===
      interaction.user.id;

    const isAdmin =
      interaction.memberPermissions?.has(
        PermissionsBitField.Flags.Administrator
      ) ||
      interaction.memberPermissions?.has(
        PermissionsBitField.Flags.ManageGuild
      );

    if (
      !isOwner &&
      !isAdmin
    ) {
      await tempReply(
        interaction,
        '❌ Chỉ chủ phòng hoặc người có quyền Quản lý Server mới có thể khôi phục panel.',
        {
          error: true
        }
      );

      return;
    }

    await refreshRoomPanelSafe(
      interaction.channel.id,
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
    !interaction.guild ||
    !interaction.channel ||
    interaction.channel.type !==
      ChannelType.GuildVoice
  ) {
    await tempReply(
      interaction,
      '❌ Hãy sử dụng `/claim` trong phòng Voice HDK.',
      {
        error: true
      }
    );

    return;
  }

  try {
    const room =
      await getRoom(
        interaction.channel.id
      );

    if (!room) {
      await tempReply(
        interaction,
        '❌ Phòng này không được Voice HDK quản lý.',
        {
          error: true
        }
      );

      return;
    }

    if (
      String(
        room.owner_id
      ) ===
      interaction.user.id
    ) {
      await tempReply(
        interaction,
        '👑 Bạn đã là chủ phòng này.',
        {
          error: true
        }
      );

      return;
    }

    const claimant =
      await getGuildMember(
        interaction.guild,
        interaction.user.id
      );

    if (
      !claimant ||
      claimant.user.bot
    ) {
      await tempReply(
        interaction,
        '❌ Không tìm thấy thành viên hợp lệ.',
        {
          error: true
        }
      );

      return;
    }

    if (
      claimant.voice?.channelId !==
      interaction.channel.id
    ) {
      await tempReply(
        interaction,
        '❌ Bạn phải đang ở trong phòng này để nhận quyền chủ.',
        {
          error: true
        }
      );

      return;
    }

    const oldOwner =
      await getGuildMember(
        interaction.guild,
        String(
          room.owner_id
        )
      );

    if (
      oldOwner?.voice?.channelId ===
      interaction.channel.id
    ) {
      await tempReply(
        interaction,
        '❌ Chủ phòng hiện tại vẫn đang ở trong phòng.',
        {
          error: true
        }
      );

      return;
    }

    const ownedRoom =
      await getOwnedRoom(
        interaction.guild.id,
        claimant.id
      );

    if (
      ownedRoom &&
      String(
        ownedRoom.channel_id
      ) !==
      interaction.channel.id
    ) {
      await tempReply(
        interaction,
        '❌ Bạn đang sở hữu một phòng Voice HDK khác.',
        {
          error: true
        }
      );

      return;
    }

    const dbClient =
      await pool.connect();

    let updated =
      false;

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
            interaction.channel.id
          ]
        );

      const current =
        locked.rows[0];

      if (!current) {
        throw new Error(
          'ROOM_NOT_FOUND'
        );
      }

      if (
        String(
          current.owner_id
        ) !==
        String(
          room.owner_id
        )
      ) {
        throw new Error(
          'OWNER_CHANGED'
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
            claimant.id,
            interaction.channel.id
          ]
        );

      if (
        duplicate.rowCount >
        0
      ) {
        throw new Error(
          'CLAIMANT_HAS_ROOM'
        );
      }

      await updateRoomOwner(
        interaction.channel.id,
        claimant.id,
        dbClient
      );

      await dbClient.query(
        'COMMIT'
      );

      updated =
        true;
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
        interaction.channel,
        claimant.id
      );

      if (
        oldOwner &&
        oldOwner.id !==
        claimant.id
      ) {
        await removeOwnerPermissions(
          interaction.channel,
          oldOwner.id
        );
      } else {
        await safeDeleteOverwrite(
          interaction.channel,
          String(
            room.owner_id
          ),
          `${BOT_NAME}: thu hồi quyền chủ cũ khi claim`
        );
      }

      await ensureBotRoomPermissions(
        interaction.channel
      );
    } catch (permissionError) {
      logError(
        'CLAIM_PERMISSION',
        permissionError
      );

      if (updated) {
        try {
          await updateRoomOwner(
            interaction.channel.id,
            String(
              room.owner_id
            )
          );

          if (oldOwner) {
            await grantOwnerPermissions(
              interaction.channel,
              oldOwner.id
            );
          }

          await safeDeleteOverwrite(
            interaction.channel,
            claimant.id,
            `${BOT_NAME}: hoàn tác claim lỗi`
          );
        } catch (rollbackError) {
          logError(
            'CLAIM_ROLLBACK',
            rollbackError
          );
        }
      }

      throw new Error(
        'Không thể cập nhật quyền phòng.'
      );
    }

    clearPendingTransfer(
      interaction.channel.id
    );

    clearSelectionsForChannel(
      interaction.guild.id,
      interaction.channel.id
    );

    await refreshRoomPanelSafe(
      interaction.channel.id
    );

    await sendActionLog(
      interaction.guild,
      '👑',
      claimant,
      `Nhận quyền chủ phòng ${interaction.channel.name}`
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

    let text =
      '❌ Không thể nhận quyền chủ phòng.';

    if (
      error?.message ===
      'OWNER_CHANGED'
    ) {
      text =
        '⚠️ Chủ phòng vừa thay đổi. Hãy thử lại.';
    }

    if (
      error?.message ===
      'CLAIMANT_HAS_ROOM'
    ) {
      text =
        '❌ Bạn đang sở hữu một phòng Voice HDK khác.';
    }

    await tempReply(
      interaction,
      text,
      {
        error: true
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
    `${ok ? '✅' : '❌'} ${label}` +
    (
      detail
        ? ` — ${detail}`
        : ''
    )
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
    await pool.query(
      'SELECT 1'
    );

    lines.push(
      doctorLine(
        true,
        'PostgreSQL'
      )
    );
  } catch (error) {
    logError(
      'DOCTOR_DATABASE',
      error
    );

    lines.push(
      doctorLine(
        false,
        'PostgreSQL',
        'Không thể kết nối'
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

  let generator = null;

  try {
    generator =
      await getGenerator(
        interaction.guild.id
      );

    lines.push(
      doctorLine(
        Boolean(
          generator
        ),
        'Cấu hình Voice HDK',
        generator
          ? cleanDisplayName(
              generator.display_name
            ) ||
            'Đã cài đặt'
          : 'Chưa cài đặt'
      )
    );
  } catch {
    lines.push(
      doctorLine(
        false,
        'Cấu hình Voice HDK',
        'Không đọc được Database'
      )
    );
  }

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
        '➕ Tạo phòng'
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

    const permissionCheck =
      await validateSetupPermissions(
        interaction.guild,
        buttonCategory?.type ===
          ChannelType.GuildCategory
          ? buttonCategory
          : null,
        blogCategory?.type ===
          ChannelType.GuildCategory
          ? blogCategory
          : null
      );

    lines.push(
      doctorLine(
        permissionCheck.ok,
        'Quyền của Bot',
        permissionCheck.ok
          ? 'Đủ quyền cần thiết'
          : permissionCheck.missing.join(
              ', '
            )
      )
    );
  }

  try {
    const regions =
      await getVoiceRegions(
        true
      );

    lines.push(
      doctorLine(
        regions.length > 0,
        'Voice Regions',
        `${regions.length} khu vực khả dụng`
      )
    );
  } catch (error) {
    logError(
      'DOCTOR_REGIONS',
      error
    );

    lines.push(
      doctorLine(
        false,
        'Voice Regions',
        'Không lấy được danh sách'
      )
    );
  }

  const embed =
    new EmbedBuilder()
      .setTitle(
        '🩺 VOICE HDK DOCTOR'
      )
      .setDescription(
        lines.join(
          '\n'
        )
      )
      .setFooter({
        text:
          `✦ ${BOT_NAME} • ${BOT_VERSION}`
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
  const category =
    await getGuildChannel(
      guild,
      String(
        generator.button_category_id ||
        ''
      )
    );

  if (
    !category ||
    category.type !==
      ChannelType.GuildCategory
  ) {
    return null;
  }

  let createVoice =
    await getGuildChannel(
      guild,
      String(
        generator.create_voice_id ||
        ''
      )
    );

  if (
    createVoice &&
    createVoice.type ===
      ChannelType.GuildVoice
  ) {
    if (
      createVoice.parentId !==
      category.id
    ) {
      try {
        await createVoice.setParent(
          category.id,
          {
            lockPermissions:
              false,
            reason:
              `${BOT_NAME}: khôi phục danh mục kênh tạo phòng`
          }
        );
      } catch (error) {
        logError(
          `RECONCILE_CREATE_PARENT:${guild.id}`,
          error
        );
      }
    }

    if (
      createVoice.name !==
      CREATE_VOICE_NAME
    ) {
      try {
        await createVoice.setName(
          CREATE_VOICE_NAME,
          `${BOT_NAME}: khôi phục tên kênh tạo phòng`
        );
      } catch (error) {
        logError(
          `RECONCILE_CREATE_NAME:${guild.id}`,
          error
        );
      }
    }

    return createVoice;
  }

  try {
    createVoice =
      await createGeneratorVoiceChannel(
        guild,
        category
      );

    const result =
      await pool.query(
        `
          UPDATE generators
          SET
            create_voice_id = $1,
            updated_at = NOW()
          WHERE guild_id = $2
          RETURNING *
        `,
        [
          createVoice.id,
          guild.id
        ]
      );

    if (
      result.rowCount === 0
    ) {
      await createVoice.delete(
        `${BOT_NAME}: cấu hình không còn tồn tại`
      ).catch(
        () => {}
      );

      return null;
    }

    console.log(
      `[${BOT_NAME}] Đã khôi phục "${CREATE_VOICE_NAME}" tại ${guild.name}.`
    );

    return createVoice;
  } catch (error) {
    logError(
      `RECONCILE_CREATE_VOICE:${guild.id}`,
      error
    );

    return null;
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
    try {
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
        await deleteRoomRecord(
          String(
            room.channel_id
          )
        );

        continue;
      }

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
          owner.id
        );
      }

      await ensureBotRoomPermissions(
        channel
      );

      const humans =
        channel.members.filter(
          member =>
            !member.user.bot
        );

      if (
        humans.size === 0
      ) {
        scheduleEmptyRoomCheck(
          channel.id,
          5000
        );

        continue;
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
}

async function reconcileGuild(
  guild
) {
  let generator;

  try {
    generator =
      await getGenerator(
        guild.id
      );
  } catch (error) {
    logError(
      `RECONCILE_CONFIG:${guild.id}`,
      error
    );

    return;
  }

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

    case 'room_transfer':
      await handleRoomTransferButton(
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

    default:
      await tempReply(
        interaction,
        '⚠️ Chức năng này không còn hợp lệ. Hãy thử lại.',
        {
          error: true
        }
      );
  }
}

async function routeSelectInteraction(
  interaction
) {
  switch (
    interaction.customId
  ) {
    case 'setup_button_category':
      await handleSetupCategorySelect(
        interaction,
        'button'
      );
      return;

    case 'setup_blog_category':
      await handleSetupCategorySelect(
        interaction,
        'blog'
      );
      return;

    case 'room_member':
      await handleRoomMemberSelect(
        interaction
      );
      return;

    case 'room_region':
      await handleRoomRegionSelect(
        interaction
      );
      return;

    default:
      await tempReply(
        interaction,
        '⚠️ Danh sách lựa chọn này không còn hợp lệ.',
        {
          error: true
        }
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
      await tempReply(
        interaction,
        '⚠️ Biểu mẫu này không còn hợp lệ.',
        {
          error: true
        }
      );
  }
}

async function routeChatInputCommand(
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

    case 'panel':
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

    default:
      await tempReply(
        interaction,
        '❌ Lệnh không được hỗ trợ.',
        {
          error: true
        }
      );
  }
}

client.on(
  Events.InteractionCreate,
  async interaction => {
    try {
      if (
        interaction.isChatInputCommand()
      ) {
        await routeChatInputCommand(
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
        interaction.isChannelSelectMenu() ||
        interaction.isUserSelectMenu() ||
        interaction.isStringSelectMenu()
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
            ephemeral: true
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

      if (
        newState.channelId
      ) {
        await handleJoinCreateVoice(
          newState
        );
      }

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
        `VOICE_STATE:${newState.guild?.id || oldState.guild?.id || 'UNKNOWN'}`,
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
        'MESSAGE_BULK_DELETE_LOG',
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

      const room =
        await getRoom(
          channel.id
        );

      if (room) {
        clearPendingTransfer(
          channel.id
        );

        clearSelectionsForChannel(
          channel.guild.id,
          channel.id
        );

        clearEmptyRoomTimer(
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

        const timer =
          setTimeout(
            () => {
              reconcileGuild(
                channel.guild
              ).catch(
                error => {
                  logError(
                    `RECREATE_GENERATOR:${channel.guild.id}`,
                    error
                  );
                }
              );
            },
            2000
          );

        timer.unref?.();

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
  guild => {
    try {
      for (
        const key
        of selectedMembers.keys()
      ) {
        if (
          key.startsWith(
            `${guild.id}:`
          )
        ) {
          selectedMembers.delete(
            key
          );
        }
      }

      for (
        const key
        of setupSessions.keys()
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
    console.log(
      `[${BOT_NAME}] Online: ${readyClient.user.tag}`
    );

    console.log(
      `[${BOT_NAME}] Version: ${BOT_VERSION}`
    );

    try {
      await registerSlashCommands();
    } catch (error) {
      logError(
        'REGISTER_COMMANDS',
        error
      );
    }

    try {
      await reconcileAllGuilds();
    } catch (error) {
      logError(
        'STARTUP_RECONCILE',
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
    `[${BOT_NAME}] Nhận ${signal}, đang tắt an toàn...`
  );

  for (
    const transfer
    of pendingTransfers.values()
  ) {
    if (
      transfer.timer
    ) {
      clearTimeout(
        transfer.timer
      );
    }
  }

  pendingTransfers.clear();

  for (
    const timer
    of emptyRoomTimers.values()
  ) {
    clearTimeout(
      timer
    );
  }

  emptyRoomTimers.clear();

  try {
    client.destroy();
  } catch {
  }

  try {
    await pool.end();
  } catch (error) {
    logError(
      'POSTGRES_SHUTDOWN',
      error
    );
  }

  try {
    healthServer.close();
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
          'SIGTERM_SHUTDOWN',
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
          'SIGINT_SHUTDOWN',
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
  try {
    await initDatabase();
  } catch (error) {
    logError(
      'DATABASE_INIT_FATAL',
      error
    );

    process.exit(
      1
    );

    return;
  }

  await new Promise(
    (
      resolve,
      reject
    ) => {
      const onError =
        error => {
          healthServer.off(
            'listening',
            onListening
          );

          reject(
            error
          );
        };

      const onListening =
        () => {
          healthServer.off(
            'error',
            onError
          );

          resolve();
        };

      healthServer.once(
        'error',
        onError
      );

      healthServer.once(
        'listening',
        onListening
      );

      healthServer.listen(
        PORT,
        '0.0.0.0'
      );
    }
  );

  console.log(
    `[${BOT_NAME}] Health server: 0.0.0.0:${PORT}/health`
  );

  try {
    await client.login(
      TOKEN
    );
  } catch (error) {
    logError(
      'DISCORD_LOGIN_FATAL',
      error
    );

    try {
      healthServer.close();
    } catch {
    }

    await pool.end().catch(
      () => {}
    );

    process.exit(
      1
    );
  }
}

startBot().catch(
  error => {
    logError(
      'STARTUP_FATAL',
      error
    );

    process.exit(
      1
    );
  }
);

// UPTIMEROBOT / RENDER FREE
// URL: https://TEN-SERVICE-CUA-BAN.onrender.com/health
// Method: GET
