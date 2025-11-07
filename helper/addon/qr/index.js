const fs = require("fs");
const path = require("path");
const pino = require("pino");
const makeWASocket = require("@whiskeysockets/baileys").default;
const {fetchLatestBaileysVersion} = require("@whiskeysockets/baileys");
const {
  DisconnectReason,
  delay,
  useMultiFileAuthState,
  getAggregateVotesInPollMessage,
  downloadMediaMessage,
  getUrlInfo,
} = require("@whiskeysockets/baileys");
const {toDataURL} = require("qrcode");
const {query} = require("../../../database/dbpromise");
const {processMessage} = require("../../inbox/inbox");

// ---- tiny logger helpers (PM2 friendly) ----
const TS = () => new Date().toISOString();
const log = (sid, ...args) => console.log(`[${TS()}] [QR:${sid}]`, ...args);
const errlog = (sid, ...args) => console.error(`[${TS()}] [QR:${sid}]`, ...args);

function extractUidFromSessionId(input) {
  return input.split("_")[0];
}

// In-memory session storage for credentials only
const sessions = new Map();
const retries = new Map();

// top-level:
const qrTimeouts = new Map(); // sessionId -> timeoutId
const registeredFlags = new Map(); // sessionId -> boolean

function extractPhoneNumber(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)(?=:|\@)/);
  return match ? match[1] : null;
}

// Helper: session FOLDER (not a file). Baileys multi-file auth expects a directory.
// const sessionsDir = (folder = "") => path.join(process.cwd(), "sessions", folder ? `${folder}` : "");
const BASE_SESS_DIR = process.env.SESSIONS_DIR || path.resolve("/var/lib/whatscrm/sessions");
const sessionsDir = (folder = "") => path.join(BASE_SESS_DIR, folder ? `${folder}` : "");

const isSessionExists = sessionId => sessions.has(sessionId);
const isSessionFolderExists = name => fs.existsSync(sessionsDir(name));

const shouldReconnect = sessionId => {
  const maxRetries = 5;
  let attempts = retries.get(sessionId) || 0;
  if (attempts < maxRetries) {
    retries.set(sessionId, attempts + 1);
    log(sessionId, "Reconnecting… attempt", attempts + 1, "/", maxRetries);
    return true;
  }
  log(sessionId, "Max reconnect attempts reached. Will not reconnect.");
  return false;
};

/**
 * Creates a new WhatsApp session and sets up event listeners.
 *
 * @param {string} sessionId
 * @param {string} [title="Chrome"]
 * @param {boolean} [isLegacy=false]
 * @param {object} [options={}]
 */
const createSession = async (
  sessionId,
  title = "Chrome",
  isLegacy = false,
  options = {getPairCode: false, syncFullHistory: false, onQr: null}
) => {
  const sessionFolder = "md_" + sessionId;
  log(sessionId, "createSession() start", {
    node: process.versions.node,
    cwd: process.cwd(),
    title,
    isLegacy,
    sessionFolder,
    sessionsPath: sessionsDir(sessionFolder),
  });

  try {
    // Ensure the parent "sessions" dir exists (Baileys can create subfolders)
    const parentDir = sessionsDir();
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, {recursive: true});
      log(sessionId, "Created parent sessions dir:", parentDir);
    }

    // Just log the state of the target folder
    const target = sessionsDir(sessionFolder);
    if (fs.existsSync(target)) {
      const st = fs.statSync(target);
      log(sessionId, "Auth target exists:", target, "isDirectory:", st.isDirectory());
    } else {
      log(sessionId, "Auth target does not exist yet (Baileys will create):", target);
    }

    const logger = pino({level: "silent"}); // keep Baileys quiet; we add our own logs

    const {state, saveCreds} = await useMultiFileAuthState(target);
    log(sessionId, "MultiFileAuthState loaded");

    const {version, isLatest} = await fetchLatestBaileysVersion();
    log(sessionId, "Using WA Web version:", version, "isLatest:", isLatest);
    const waConfig = {
      auth: state,
      printQRInTerminal: false,
      logger,
      browser: [title || "Chrome", "122.0.0.0", "Windows 10"],
      version,
      defaultQueryTimeoutMs: 0,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      generateHighQualityLinkPreview: true,
      syncFullHistory: options.syncFullHistory,
      getMessage: async () => undefined,
    };

    log(sessionId, "Baileys config ready. Connecting…");
    const wa = makeWASocket(waConfig);

    // keep a reference (avoid spreading instance)
    sessions.set(sessionId, Object.assign(wa, {isLegacy}));
    // wa.ev.on("creds.update", () => {
    //   log(sessionId, "creds.update fired → saving creds");
    //   saveCreds().catch(e => errlog(sessionId, "saveCreds error:", e?.stack || e));
    // });

    wa.ev.on("creds.update", async () => {
      log(sessionId, "creds.update fired → saving creds");
      try {
        await saveCreds();
      } catch (e) {
        errlog(sessionId, "saveCreds error:", e?.stack || e);
      }

      // If creds are registered, cancel any pending QR timeout
      try {
        const isReg = state?.creds?.registered === true;
        if (isReg) {
          registeredFlags.set(sessionId, true);
          const t = qrTimeouts.get(sessionId);
          if (t) {
            clearTimeout(t);
            qrTimeouts.delete(sessionId);
            log(sessionId, "creds.registered=true → cleared QR timeout");
          }
        }
      } catch {}
    });

    // Message updates (polls etc.)
    wa.ev.on("messages.update", async m => {
      const message = m?.[0];
      if (!message) return;
      log(sessionId, "messages.update event:", {
        hasPollUpdates: !!message?.update?.pollUpdates?.length,
        remoteJid: message?.key?.remoteJid,
      });

      if (message?.update?.pollUpdates?.length > 0) {
        const pollCreation = await waConfig.getMessage(message.key);
        if (pollCreation) {
          const pollMessage = getAggregateVotesInPollMessage({
            message: pollCreation,
            pollUpdates: message.update.pollUpdates,
          });
          log(sessionId, "Poll updated →", pollMessage);
        }
      } else if (message?.update && message?.key?.remoteJid !== "status@broadcast") {
        const uid = extractUidFromSessionId(sessionId);
        if (uid && message?.update?.status) {
          log(sessionId, "messages.update → forwarding to processMessage(qr:update)");
          processMessage({
            body: message,
            uid,
            origin: "qr",
            getSession,
            sessionId,
            qrType: "update",
          });
        }
      }
    });

    // Incoming messages
    wa.ev.on("messages.upsert", async m => {
      const message = m?.messages?.[0];
      log(sessionId, "messages.upsert event:", {
        type: m?.type,
        hasMessage: !!message,
        remoteJid: message?.key?.remoteJid,
      });

      if (message?.key?.remoteJid !== "status@broadcast" && m.type === "notify" && message?.key?.remoteJid?.endsWith("@s.whatsapp.net")) {
        const uid = extractUidFromSessionId(sessionId);
        if (uid) {
          log(sessionId, "messages.upsert → forwarding to processMessage(qr:upsert)");
          processMessage({
            body: message,
            uid,
            origin: "qr",
            getSession,
            sessionId,
            qrType: "upsert",
          });
        }
      }
    });

    // Connection + QR lifecycle
    wa.ev.on("connection.update", async update => {
      const {connection, lastDisconnect, qr} = update;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      log(sessionId, "connection.update:", {
        connection,
        hasQR: !!qr,
        statusCode,
        lastDisconnectMsg: lastDisconnect?.error?.message,
        lastDisconnectStack: lastDisconnect?.error?.stack,
      });

      if (connection === "open") {
        retries.delete(sessionId);
        log(sessionId, "Session connected ✔️");
        try {
          const sessionData = getSession(sessionId);
          // In recent Baileys, user info is on .user after open
          const userData = sessionData?.user || sessionData?.authState?.creds?.me;
          log(sessionId, "Connected user data:", userData);

          const number = extractPhoneNumber(userData?.id) || null;
          const dataJson = userData?.id ? JSON.stringify(userData) : null;

          const q = "UPDATE instance SET status = ?, number = ?, data = ? WHERE uniqueId = ?";
          const args = ["ACTIVE", number, dataJson, sessionId];
          log(sessionId, "DB UPDATE on open:", {q, args});
          await query(q, args);
          log(sessionId, "DB UPDATE success (ACTIVE)");
        } catch (e) {
          errlog(sessionId, "DB update error (open):", e?.stack || e);
        }
        const t = qrTimeouts.get(sessionId);
        if (t) {
          clearTimeout(t);
          qrTimeouts.delete(sessionId);
          log(sessionId, "connection open → cleared QR timeout");
        }
        registeredFlags.set(sessionId, true);
        // ... rest of your ACTIVE DB update code
        return;
      }

      if (connection === "close") {
        log(sessionId, "Connection closed");
        if (statusCode === DisconnectReason.loggedOut || !shouldReconnect(sessionId)) {
          log(sessionId, "Logged out or no reconnect → marking INACTIVE & deleting session");
          try {
            await query("UPDATE instance SET status = ? WHERE uniqueId = ?", ["INACTIVE", sessionId]);
            log(sessionId, "DB UPDATE success (INACTIVE)");
          } catch (e) {
            errlog(sessionId, "DB update error (close):", e?.stack || e);
          }
          deleteSession(sessionId, isLegacy);
          return;
        }
        const waitMs = statusCode === DisconnectReason.restartRequired ? 0 : 5000;
        log(sessionId, `Scheduling reconnect in ${waitMs}ms`);
        setTimeout(() => createSession(sessionId, "Chrome", isLegacy, options), waitMs);
      }

      if (qr) {
        try {
          log(sessionId, "QR payload received from Baileys. Converting to data URL…");
          const qrCodeImage = await toDataURL(qr);
          log(sessionId, "QR generated (base64 length):", qrCodeImage?.length);

          try {
            const q2 = "UPDATE instance SET qr = ? WHERE uniqueId = ?";
            const args2 = [qrCodeImage, sessionId];
            log(sessionId, "DB UPDATE QR:", {q2, args2_len: [qrCodeImage?.length, sessionId]});
            const r = await query(q2, args2);
            // log(sessionId, "DB UPDATE success (QR stored)");
            log(sessionId, "DB UPDATE QR result:", r);
            setTimeout(async () => {
              /* 5 minutes */
            }, 300000);
          } catch (e) {
            errlog(sessionId, "DB update error (qr):", e?.stack || e);
          }

          if (typeof options.onQr === "function") {
            log(sessionId, "Invoking options.onQr callback");
            options.onQr(qrCodeImage);
          }

          // 60s timeout — if not scanned, clean up
          // setTimeout(async () => {
          //   const sessionInstance = getSession(sessionId);
          //   const notScanned = sessionInstance && sessionInstance?.authState && !sessionInstance.authState.creds?.registered;

          //   log(sessionId, "QR scan timeout check → notScanned:", notScanned);
          //   if (notScanned) {
          //     log(sessionId, "Not scanned in time → logging out & deleting");
          //     try {
          //       await sessionInstance.logout();
          //       log(sessionId, "logout() success");
          //     } catch (e) {
          //       errlog(sessionId, "Error during logout:", e?.stack || e);
          //     } finally {
          //       deleteSession(sessionId, isLegacy);
          //     }
          //   }
          // }, 60000);
          const timeoutMs = 300000; // 5 minutes (more realistic)
          const prev = qrTimeouts.get(sessionId);
          if (prev) clearTimeout(prev);
          const timer = setTimeout(async () => {
            // If already registered/open by now, do nothing
            if (registeredFlags.get(sessionId) === true) {
              log(sessionId, "QR timeout fired but session is registered → ignore");
              qrTimeouts.delete(sessionId);
              return;
            }
            const sessionInstance = getSession(sessionId);
            const notScanned =
              sessionInstance &&
              state && // use the closure state, not sessionInstance.authState
              state.creds &&
              !state.creds.registered;

            log(sessionId, "QR scan timeout check → notScanned:", notScanned);
            if (notScanned) {
              log(sessionId, "Not scanned in time → logging out & deleting");
              try {
                await sessionInstance.logout();
                log(sessionId, "logout() success");
              } catch (e) {
                errlog(sessionId, "Error during logout:", e?.stack || e);
              } finally {
                deleteSession(sessionId, isLegacy);
              }
            }
            qrTimeouts.delete(sessionId);
          }, timeoutMs);
          qrTimeouts.set(sessionId, timer);
        } catch (e) {
          errlog(sessionId, "QR processing error:", e?.stack || e);
        }
      }
    });

    return "Session initiated";
  } catch (e) {
    errlog(sessionId, "createSession() fatal error:", e?.stack || e);
    throw e;
  }
};

const getSession = sessionId => sessions.get(sessionId) || null;

// Recursively delete a directory and its contents
const deleteDirectory = directoryPath => {
  if (fs.existsSync(directoryPath)) {
    fs.readdirSync(directoryPath).forEach(file => {
      const filePath = path.join(directoryPath, file);
      if (fs.lstatSync(filePath).isDirectory()) {
        deleteDirectory(filePath);
      } else {
        fs.unlinkSync(filePath);
      }
    });
    fs.rmdirSync(directoryPath);
  }
};

const deleteSession = async (sessionId, isLegacy = false) => {
  const sessionFolder = "md_" + sessionId;
  const baseDir = process.cwd();
  log(sessionId, "deleteSession() start", {sessionFolder});

  // Remove contacts file if exists
  const contactsPath = path.join(baseDir, "contacts", `${sessionId}.json`);
  if (fs.existsSync(contactsPath)) {
    try {
      fs.unlinkSync(contactsPath);
      log(sessionId, "Deleted contacts file:", contactsPath);
    } catch (e) {
      errlog(sessionId, "Error deleting contacts file:", e?.stack || e);
    }
  }

  const folderPath = sessionsDir(sessionFolder);
  if (isSessionFolderExists(sessionFolder)) {
    log(sessionId, "Deleting auth folder:", folderPath);
    deleteDirectory(folderPath);
  } else {
    log(sessionId, "Auth folder not found to delete:", folderPath);
  }

  sessions.delete(sessionId);
  retries.delete(sessionId);

  try {
    await query("UPDATE instance SET status = ? WHERE uniqueId = ?", ["INACTIVE", sessionId]);
    log(sessionId, "DB UPDATE success (INACTIVE) from deleteSession()");
  } catch (e) {
    errlog(sessionId, "DB update error (deleteSession):", e?.stack || e);
  }
};

const getChatList = () => {
  return [];
};

const isExists = async (session, jid, isGroup = false) => {
  try {
    if (isGroup) {
      const result = await session.groupMetadata(jid);
      return Boolean(result?.id);
    }
    let [result] = await session.onWhatsApp(jid);
    if (typeof result === "undefined") {
      const getNum = jid.replace("@s.whatsapp.net", "");
      [result] = await session.onWhatsApp(`+${getNum}`);
    }
    return result?.exists;
  } catch (err) {
    errlog("GLOBAL", "isExists error:", err?.stack || err);
    return false;
  }
};

function replaceWithRandom(inputText) {
  let updatedText = inputText;
  while (updatedText.includes("[") && updatedText.includes("]")) {
    const start = updatedText.indexOf("[");
    const end = updatedText.indexOf("]");
    if (start !== -1 && end !== -1) {
      const arrayText = updatedText.substring(start + 1, end);
      const items = arrayText.split(",").map(item => item.trim());
      if (items.length > 0) {
        const randomItem = items[Math.floor(Math.random() * items.length)];
        updatedText = updatedText.substring(0, start) + randomItem + updatedText.substring(end + 1);
      }
    }
  }
  return updatedText;
}

const sendMessage = async (session, receiver, message) => {
  try {
    log("GLOBAL", "sendMessage() start", {receiver, hasText: !!message?.text});
    if (message?.text) {
      const linkPreview = await getUrlInfo(message?.text, {
        thumbnailWidth: 1024,
        fetchOpts: {timeout: 5000},
        uploadImage: session.waUploadToServer,
      });
      message = {
        text: replaceWithRandom(message?.text),
        linkPreview,
      };
    }
    if (message?.caption) {
      message = {...message, caption: replaceWithRandom(message?.caption)};
    }
    await delay(300);
    const resp = await session.sendMessage(receiver, message);
    log("GLOBAL", "sendMessage() success");
    return resp;
  } catch (err) {
    errlog("GLOBAL", "sendMessage error:", err?.stack || err);
    return Promise.reject(null);
  }
};

const getGroupData = async (session, jid) => {
  try {
    return await session.groupMetadata(jid);
  } catch (err) {
    errlog("GLOBAL", "getGroupData error:", err?.stack || err);
    return Promise.reject(null);
  }
};

const formatPhone = phone => {
  if (phone.endsWith("@s.whatsapp.net")) return phone;
  let formatted = phone.replace(/\D/g, "");
  return formatted + "@s.whatsapp.net";
};

const formatGroup = group => {
  if (group.endsWith("@g.us")) return group;
  let formatted = group.replace(/[^\d-]/g, "");
  return formatted + "@g.us";
};

const cleanup = () => {
  console.log(`[${TS()}] cleanup() called`);
};

// Utility for duplicate instances (unchanged from your version)
function getBeforeUnderscore(str) {
  const index = str.indexOf("_");
  return index !== -1 ? str.slice(0, index) : str;
}

function renameFilesInDirectory(filePath, number, sessionId, newSessionId) {
  fs.readdir(filePath, (err, files) => {
    if (err) {
      errlog("GLOBAL", "Error reading directory:", err?.stack || err);
      return;
    }
    files.forEach(file => {
      if (file.startsWith(`${number}_${sessionId}`) && file.endsWith(".json")) {
        const oldFilePath = path.join(filePath, file);
        const newFileName = `${number}_${newSessionId}.json`;
        const newFilePath = path.join(filePath, newFileName);
        fs.rename(oldFilePath, newFilePath, renameErr => {
          if (renameErr) {
            errlog("GLOBAL", "Error renaming file:", renameErr?.stack || renameErr);
          } else {
            log("GLOBAL", `Renamed ${file} to ${newFileName}`);
          }
        });
      }
    });
  });
}

async function updateDuplicateInstance({sessionId, number, userData}) {
  try {
    log(sessionId, "updateDuplicateInstance()", {number, userData});
    const uid = getBeforeUnderscore(sessionId);
    if (!uid) return;

    const allInstance = await query(`SELECT * FROM instance WHERE uid = ? AND number = ?`, [uid, number]);
    const removeThisInstance = allInstance.filter(instance => instance.uniqueId !== sessionId);

    if (removeThisInstance.length > 0) {
      for (const instance of removeThisInstance) {
        const insId = instance.uniqueId;
        log(sessionId, "Deleting duplicate instance:", insId);
        await deleteSession(insId);
        const convoFilePath = `${__dirname}/../../../conversations/inbox/${uid}`;
        renameFilesInDirectory(convoFilePath, number, insId, sessionId);
        const thisChatId = await query(`SELECT * FROM chats WHERE uid = ? AND chat_id LIKE ?`, [uid, `${insId}%`]);
        for (const chat of thisChatId) {
          const newChatId = chat.chat_id.replace(insId, sessionId);
          await query(`UPDATE chats SET chat_id = ? WHERE id = ?`, [newChatId, chat.id]);
          log(sessionId, `chatId ${chat.chat_id} → ${newChatId}`);
        }
      }
    }
  } catch (err) {
    errlog(sessionId, "updateDuplicateInstance error:", err?.stack || err);
  }
}

/**
 * Bootstraps sessions from the sessions/ directory (folders named md_<id>)
 */
const init = () => {
  const sessionsPath = sessionsDir();
  console.log(`[${TS()}] init(): scanning`, sessionsPath);
  fs.readdir(sessionsPath, (err, items) => {
    if (err) {
      console.error(`[${TS()}] init() read error:`, err?.stack || err);
      return;
    }
    items.forEach(name => {
      const full = path.join(sessionsPath, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        return;
      }
      if (!stat.isDirectory()) return;
      if (!name.startsWith("md_")) return;
      const sessionId = name.substring(3);
      console.log(`[${TS()}] init(): booting session`, sessionId);
      // correct parameter order: (sessionId, title, isLegacy)
      createSession(sessionId, "Chrome", false);
    });
  });
};

function checkQr() {
  return true;
}

module.exports = {
  isSessionExists,
  createSession,
  getSession,
  deleteSession,
  getChatList,
  isExists,
  sendMessage,
  formatPhone,
  formatGroup,
  cleanup,
  init,
  getGroupData,
  getUrlInfo,
  downloadMediaMessage,
  replaceWithRandom,
  checkQr,
};
