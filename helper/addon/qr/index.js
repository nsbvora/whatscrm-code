const fs = require("fs");
const path = require("path");
const pino = require("pino");
const makeWASocket = require("@whiskeysockets/baileys").default;
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

function extractUidFromSessionId(input) {
  return input.split("_")[0]; // Split by underscore and return the first part
}

// In-memory session storage for credentials only
const sessions = new Map();
const retries = new Map();

function extractPhoneNumber(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)(?=:|\@)/);
  return match ? match[1] : null;
}

// Helper: get the session folder path using process.cwd()
// NOTE: useMultiFileAuthState expects a DIRECTORY, not a file.
const sessionsDir = (folder = "") => path.join(process.cwd(), "sessions", folder ? `${folder}` : "");

const isSessionFolderExists = name => fs.existsSync(sessionsDir(name));

const shouldReconnect = sessionId => {
  const maxRetries = 5;
  let attempts = retries.get(sessionId) || 0;
  if (attempts < maxRetries) {
    retries.set(sessionId, attempts + 1);
    console.log("Reconnecting...", {attempts: attempts + 1, sessionId});
    return true;
  }
  return false;
};

/**
 * Creates a new WhatsApp session and sets up event listeners.
 *
 * This async function immediately returns once the session is initiated,
 * without waiting for the connection (QR scanning, etc.) to complete.
 *
 * If a QR code is generated during connection, and if an optional `onQr`
 * callback is provided in options, it will be called with the QR code (as a Data URL).
 *
 * If the session is not scanned within 60 seconds, it will log out and delete itself.
 *
 * Before starting, if an existing session folder is found for this sessionId,
 * it will be reused (MultiFileAuthState-safe). Delete via deleteSession() to reset.
 *
 * @param {string} sessionId - Unique session identifier.
 * @param {string} [title="Chrome"] - Browser title for the Baileys client tuple.
 * @param {boolean} [isLegacy=false] - (Unused legacy flag; kept for compatibility).
 * @param {object} [options={}] - Additional options.
 * @param {boolean} [options.getPairCode=false] - (Unused here).
 * @param {boolean} [options.syncFullHistory=false] - (Not used since chats/contacts aren’t stored).
 * @param {function} [options.onQr] - Optional callback to be invoked with QR code.
 * @returns {Promise<string>} Resolves with "Session initiated" immediately.
 */
const createSession = async (
  sessionId,
  title = "Chrome",
  isLegacy = false,
  options = {getPairCode: false, syncFullHistory: false, onQr: null}
) => {
  const sessionFolder = "md_" + sessionId;
  const logger = pino({level: "silent"});

  const {state, saveCreds} = await useMultiFileAuthState(sessionsDir(sessionFolder));

  const waConfig = {
    auth: state,
    printQRInTerminal: false,
    logger,
    browser: [title || "Chrome", "", ""],
    defaultQueryTimeoutMs: 0,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    generateHighQualityLinkPreview: true,
    syncFullHistory: options.syncFullHistory,
    getMessage: async key => {
      // No message store in this build; return undefined.
      return undefined;
    },
  };

  const wa = makeWASocket(waConfig);
  // Keep a reference with a small extension (avoid spreading complex instance)
  sessions.set(sessionId, Object.assign(wa, {isLegacy}));
  wa.ev.on("creds.update", saveCreds);

  // Listen for message updates (e.g., poll updates)
  wa.ev.on("messages.update", async m => {
    const message = m[0];
    if (message?.update?.pollUpdates?.length > 0) {
      // Use the getMessage function we provided to Baileys config
      const pollCreation = await waConfig.getMessage(message.key);
      if (pollCreation) {
        const pollMessage = getAggregateVotesInPollMessage({
          message: pollCreation,
          pollUpdates: message.update.pollUpdates,
        });
        console.log("Poll updated:", pollMessage);
      }
    } else if (message?.update && message?.key?.remoteJid !== "status@broadcast") {
      const uid = extractUidFromSessionId(sessionId);
      if (uid && message?.update?.status) {
        processMessage({
          body: message,
          uid: extractUidFromSessionId(sessionId),
          origin: "qr",
          getSession,
          sessionId,
          qrType: "update",
        });
      }
    }
  });

  // Log incoming messages
  wa.ev.on("messages.upsert", async m => {
    const message = m.messages?.[0];

    if (message?.key?.remoteJid !== "status@broadcast" && m.type === "notify" && message?.key?.remoteJid?.endsWith("@s.whatsapp.net")) {
      const uid = extractUidFromSessionId(sessionId);
      if (uid) {
        processMessage({
          body: message,
          uid: extractUidFromSessionId(sessionId),
          origin: "qr",
          getSession,
          sessionId,
          qrType: "upsert",
        });
      }
    }
  });

  // Handle connection updates and QR generation asynchronously.
  wa.ev.on("connection.update", async update => {
    const {connection, lastDisconnect, qr} = update;
    const statusCode = lastDisconnect?.error?.output?.statusCode;

    if (connection === "open") {
      retries.delete(sessionId);
      console.log(`Session ${sessionId} connected.`);
      // Update instance status to ACTIVE in the DB
      try {
        const sessionData = getSession(sessionId);
        const userData = sessionData?.user; // populated after "open"
        console.dir({userData}, {depth: null});

        await query("UPDATE instance SET status = ?, number = ?, data = ? WHERE uniqueId = ?", [
          "ACTIVE",
          extractPhoneNumber(userData?.id) || null,
          userData?.id ? JSON.stringify(userData) : null,
          sessionId,
        ]);

        // Optionally de-duplicate instances:
        // await updateDuplicateInstance({
        //   sessionId,
        //   number: extractPhoneNumber(userData?.id),
        //   userData,
        // });
      } catch (error) {
        console.error("Database update error (open):", error);
      }
    } else if (connection === "close") {
      if (statusCode === DisconnectReason.loggedOut || !shouldReconnect(sessionId)) {
        console.log(`Session ${sessionId} disconnected permanently.`);
        // Update instance status to INACTIVE in the DB before deletion
        try {
          await query("UPDATE instance SET status = ? WHERE uniqueId = ?", ["INACTIVE", sessionId]);
        } catch (error) {
          console.error("Database update error (close):", error);
        }
        deleteSession(sessionId, isLegacy);
        return;
      }
      const waitMs = statusCode === DisconnectReason.restartRequired ? 0 : 5000;
      console.log(`Reconnecting session ${sessionId} in ${waitMs}ms...`);
      setTimeout(() => createSession(sessionId, "Chrome", isLegacy, options), waitMs);
    }

    if (qr) {
      try {
        const qrCodeImage = await toDataURL(qr);
        // Update instance data with the latest QR code
        try {
          await query("UPDATE instance SET qr = ? WHERE uniqueId = ?", [qrCodeImage, sessionId]);
        } catch (error) {
          console.error("Database update error (qr):", error);
        }
        if (typeof options.onQr === "function") {
          options.onQr(qrCodeImage);
        }
        // Start a 60-second timeout: if not scanned, logout and delete.
        setTimeout(async () => {
          const sessionInstance = getSession(sessionId);
          try {
            // If creds are not registered yet, it's not scanned.
            const notScanned = sessionInstance && sessionInstance?.authState && !sessionInstance.authState.creds?.registered;

            if (notScanned) {
              console.log(`Session ${sessionId} was not scanned in time. Logging out and deleting session.`);
              try {
                await sessionInstance.logout();
              } catch (err) {
                console.error("Error during logout:", err);
              } finally {
                deleteSession(sessionId, isLegacy);
              }
            }
          } catch (err) {
            console.error("QR timeout check error:", err);
          }
        }, 60000);
      } catch (error) {
        console.error("QR processing error:", error);
      }
    }
  });

  // Immediately return once the session is initiated.
  return "Session initiated";
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

/**
 * Deletes a session by removing its files and clearing it from memory.
 *
 * @param {string} sessionId - Unique session identifier.
 * @param {boolean} [isLegacy=false]
 */
const deleteSession = async (sessionId, isLegacy = false) => {
  const sessionFolder = "md_" + sessionId;
  const baseDir = process.cwd();

  // Remove contacts file if exists
  const contactsPath = path.join(baseDir, "contacts", `${sessionId}.json`);
  if (fs.existsSync(contactsPath)) {
    fs.unlinkSync(contactsPath);
  }

  if (isSessionFolderExists(sessionFolder)) {
    deleteDirectory(sessionsDir(sessionFolder));
  }

  sessions.delete(sessionId);
  retries.delete(sessionId);

  // Update instance status to INACTIVE in the DB
  try {
    await query("UPDATE instance SET status = ? WHERE uniqueId = ?", ["INACTIVE", sessionId]);
  } catch (error) {
    console.error("Database update error (deleteSession):", error);
  }
};

/**
 * Returns a list of chats for the session.
 * Since we are not using a store for messages, this returns an empty array.
 *
 * @param {string} sessionId
 * @param {boolean} [isGroup=false]
 */
const getChatList = (sessionId, isGroup = false) => {
  return [];
};

/**
 * Checks whether a JID exists (user or group) using the session.
 *
 * @param {object} session - The WhatsApp session.
 * @param {string} jid - The JID to check.
 * @param {boolean} [isGroup=false]
 */
const isExists = async (session, jid, isGroup = false) => {
  try {
    let result;
    if (isGroup) {
      result = await session.groupMetadata(jid);
      return Boolean(result.id);
    }
    [result] = await session.onWhatsApp(jid);
    if (typeof result === "undefined") {
      const getNum = jid.replace("@s.whatsapp.net", "");
      [result] = await session.onWhatsApp(`+${getNum}`);
    }
    return result?.exists;
  } catch (err) {
    console.error("isExists error:", err);
    return false;
  }
};

/**
 * Replaces text within brackets with a random item from the comma-separated list.
 *
 * Example: "Hello [Alice,Bob]" may become "Hello Bob"
 *
 * @param {string} inputText
 */
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

/**
 * Sends a message using the given session.
 *
 * @param {object} session - The WhatsApp session.
 * @param {string} receiver - The recipient JID.
 * @param {object} message - The message object.
 */
const sendMessage = async (session, receiver, message) => {
  try {
    console.log("A");
    if (message?.text) {
      console.log("B");
      const linkPreview = await getUrlInfo(message?.text, {
        thumbnailWidth: 1024,
        fetchOpts: {timeout: 5000},
        uploadImage: session.waUploadToServer,
      });
      console.log("C");
      message = {
        text: replaceWithRandom(message?.text),
        linkPreview,
      };
    } else {
      console.log("D");
    }
    console.log("E", {sendingMsg: message});
    if (message?.caption) {
      console.log("F");
      message = {...message, caption: replaceWithRandom(message?.caption)};
    }
    console.log("H", {isLegacy: session?.isLegacy || "NA", message});
    await delay(1000);
    console.log("I");
    return session.sendMessage(receiver, message);
  } catch (err) {
    console.error("sendMessage error:", err);
    return Promise.reject(null);
  }
};

/**
 * Retrieves group metadata.
 *
 * @param {object} session - The WhatsApp session.
 * @param {string} jid - The group JID.
 */
const getGroupData = async (session, jid) => {
  try {
    return await session.groupMetadata(jid);
  } catch (err) {
    console.error("getGroupData error:", err);
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
  console.log("Running cleanup before exit.");
  // No store to write out in this version.
};

function getBeforeUnderscore(str) {
  const index = str.indexOf("_");
  if (index !== -1) {
    return str.slice(0, index);
  }
  return str; // If no underscore, return the original string
}

function renameFilesInDirectory(filePath, number, sessionId, newSessionId) {
  // Read the directory contents
  fs.readdir(filePath, (err, files) => {
    if (err) {
      console.error("Error reading directory:", err);
      return;
    }

    // Iterate over each file in the directory
    files.forEach(file => {
      // Check if the file matches the pattern number_sessionId.json
      if (file.startsWith(`${number}_${sessionId}`) && file.endsWith(".json")) {
        const oldFilePath = path.join(filePath, file);
        const newFileName = `${number}_${newSessionId}.json`;
        const newFilePath = path.join(filePath, newFileName);

        // Rename the file
        fs.rename(oldFilePath, newFilePath, renameErr => {
          if (renameErr) {
            console.error("Error renaming file:", renameErr);
          } else {
            console.log(`Renamed ${file} to ${newFileName}`);
          }
        });
      }
    });
  });
}

async function updateDuplicateInstance({sessionId, number, userData}) {
  try {
    console.log({updateDuplicate: number});
    const uid = getBeforeUnderscore(sessionId);
    if (!uid) return;

    // check if the number has more instances
    const allInstance = await query(`SELECT * FROM instance WHERE uid = ? AND number = ?`, [uid, number]);

    const removeThisInstance = allInstance.filter(instance => instance.uniqueId !== sessionId);

    if (removeThisInstance.length > 0) {
      // Use a for...of loop to properly handle async operations
      for (const instance of removeThisInstance) {
        const insId = instance.uniqueId;

        console.log({insId});

        // logging out other session
        await deleteSession(insId);

        // renaming the chats locally
        const convoFilePath = `${__dirname}/../../../conversations/inbox/${uid}`;
        renameFilesInDirectory(convoFilePath, number, insId, sessionId);

        console.log({convoFilePath, number, insId, uid});

        // getting chats from mysql for this number
        const thisChatId = await query(`SELECT * FROM chats WHERE uid = ? AND chat_id LIKE ?`, [uid, `${insId}%`]);
        console.log({thisChatId});

        for (const chat of thisChatId) {
          console.log(`chatId ${chat.chat_id} updated to ${sessionId}`);
          const newChatId = chat.chat_id.replace(insId, sessionId);
          await query(`UPDATE chats SET chat_id = ? WHERE id = ?`, [newChatId, chat.id]);

          console.log(`old chatid ${chat.chat_id} updated to ${newChatId}`);
        }
      }
    }
  } catch (err) {
    console.log(err);
  }
}

/**
 * Reads the sessions folder and automatically creates sessions for saved folders.
 */
const init = () => {
  const sessionsPath = path.join(process.cwd(), "sessions");
  fs.readdir(sessionsPath, (err, items) => {
    if (err) {
      console.error("Error reading sessions directory:", err);
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
      // title, isLegacy=false (we only use MD-style multi-file auth)
      createSession(sessionId, "Chrome", false);
    });
  });
};

function checkQr() {
  const check = true;
  return check;
}

module.exports = {
  isSessionExists: sessionId => sessions.has(sessionId),
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
