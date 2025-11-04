const { downloadMediaMessage } = require("baileys");
const randomstring = require("randomstring");
const moment = require("moment");
const { query } = require("../../../database/dbpromise");
const mime = require("mime-types");
const { fetchProfileUrl } = require("./control");
const fs = require("fs");

function timeoutPromise(promise, ms) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), ms));
  return Promise.race([promise, timeout]);
}

function extractPhoneNumber(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)(?=:|\@)/);
  return match ? match[1] : null;
}

async function updateProfileMysql({
  chatId,
  uid,
  getSession,
  remoteJid,
  sessionId,
}) {
  try {
    if (remoteJid.includes("@g.us")) return;

    const session = await timeoutPromise(getSession(sessionId || "a"), 60000);
    if (!session) return;

    const image = await fetchProfileUrl(session, remoteJid);
    if (!image) return;

    // Get existing chat data to preserve other fields
    const [chat] = await query(
      `SELECT * FROM beta_chats WHERE uid = ? AND chat_id = ?`,
      [uid, chatId]
    );

    if (chat) {
      const profile = chat.profile_image
        ? { ...JSON.parse(chat.profile_image), profileImage: image }
        : { profileImage: image };
      await query(
        `UPDATE beta_chats SET last_message = JSON_SET(COALESCE(last_message, '{}'), '$.profileImage', ?), profile = ? WHERE uid = ? AND chat_id = ?`,
        [image, JSON.stringify(profile), uid, chatId]
      );
    }
  } catch (err) {
    console.log("Error updating profile data:", err);
  }
}

async function updateChatInMysql({
  chatId,
  uid,
  senderName,
  senderMobile,
  actualMsg,
  sessionId,
  getSession,
  jid,
}) {
  try {
    const allowedMessageTypes = ["text", "image", "document", "video", "audio"];
    const isIncoming = actualMsg?.route === "INCOMING";

    // Update profile data if needed
    updateProfileMysql({ chatId, uid, getSession, remoteJid: jid, sessionId });

    // Check if user exists
    const [user] = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);
    if (!user) return;

    // Get session data for origin_instance_id
    const sessionData = await getSession(sessionId);
    const originInstanceId =
      sessionData?.authState?.creds?.me || sessionData.user;

    // Check if chat exists
    const [chat] = await query(
      `SELECT * FROM beta_chats WHERE chat_id = ? AND uid = ?`,
      [chatId, uid]
    );

    const updateFields = {
      last_message: JSON.stringify(actualMsg),
      sender_name: senderName || "NA",
      sender_mobile: senderMobile || "NA",
      origin: "qr",
      origin_instance_id: JSON.stringify(originInstanceId),
    };

    if (isIncoming && allowedMessageTypes.includes(actualMsg?.type)) {
      updateFields.unread_count = chat?.unread_count
        ? chat.unread_count + 1
        : 1;
    }

    if (chat) {
      await query(`UPDATE beta_chats SET ? WHERE chat_id = ? AND uid = ?`, [
        updateFields,
        chatId,
        uid,
      ]);
    } else {
      await query(`INSERT INTO beta_chats SET ?`, {
        ...updateFields,
        uid,
        chat_id: chatId,
        assigned_agent: null,
      });
    }
  } catch (err) {
    console.log("Error updating chat:", err);
  }
}

function getCurrentTimestampInTimeZone(timezone) {
  if (typeof timezone === "number") {
    return timezone;
  } else if (typeof timezone === "string") {
    const currentTimeInZone = moment.tz(timezone);
    return Math.round(currentTimeInZone.valueOf() / 1000);
  }
  return Math.round(Date.now() / 1000);
}

function saveImageToFile(imageBuffer, filePath, mimetype) {
  try {
    fs.writeFileSync(filePath, imageBuffer);
    console.log(`${mimetype || "IMG"} saved successfully as ${filePath}`);
  } catch (error) {
    console.error(`Error saving image: ${error.message}`);
  }
}

function downloadMediaPromise(m, mimetype) {
  return new Promise(async (resolve) => {
    try {
      const bufferMsg = await downloadMediaMessage(m, "buffer", {}, {});
      const randomSt = randomstring.generate(6);
      const mimeType = mime.extension(mimetype);
      const fileName = `${randomSt}_qr.${mimeType}`;
      const filePath = `${__dirname}/../../../client/public/meta-media/${fileName}`;

      saveImageToFile(bufferMsg, filePath, mimetype);

      resolve({ success: true, fileName });
    } catch (err) {
      console.log(err);
      resolve({ err, success: false });
    }
  });
}

function extractPhoneNumber(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)(?=:|\@)/);
  return match ? match[1] : null;
}

function getChatId({ instanceNumber, senderMobile, uid }) {
  try {
    return `${instanceNumber}_${extractPhoneNumber(senderMobile)}_${uid}`;
  } catch (error) {
    return null;
  }
}

async function saveMessageToConversation({ uid, chatId, messageData }) {
  try {
    await query(`INSERT INTO beta_conversation SET ?`, {
      type: messageData.type,
      metaChatId: messageData.metaChatId,
      msgContext: JSON.stringify(messageData.msgContext),
      reaction: messageData.reaction || "",
      timestamp: messageData.timestamp,
      senderName: messageData.senderName,
      senderMobile: messageData.senderMobile,
      star: messageData.star ? 1 : 0,
      route: messageData.route,
      context: messageData.context ? JSON.stringify(messageData.context) : null,
      origin: messageData.origin,
      uid,
      chat_id: chatId,
    });
    return true;
  } catch (err) {
    console.log("Error saving message to conversation:", err);
    return false;
  }
}

async function processBaileysMsg({ body, uid, userFromMysql, chatId }) {
  try {
    if (!body) return null;

    // Status Update Handling
    if (body.update && typeof body.update.status === "number") {
      if (!body.key?.fromMe) {
        console.log(
          `Status update for incoming message ${body.key.id} ignored.`
        );
        return { newMessage: null, chatId };
      }

      const statusMapping = { 2: "sent", 3: "delivered", 4: "read" };
      const newStatusNumber = body.update.status;
      const newStatus = statusMapping[newStatusNumber] || "";

      await query(
        `UPDATE beta_conversation SET status = ? WHERE metaChatId = ? AND uid = ?`,
        [newStatus, body.key.id, uid]
      );

      return { newMessage: null, chatId };
    }

    let msgContext = null;
    let referencedMessageData = null;

    // Determine message type
    if (body.message.conversation) {
      msgContext = {
        type: "text",
        text: {
          body: body.message.conversation,
          preview_url: true,
        },
      };
    } else if (body.message.reactionMessage) {
      const reaction = body.message.reactionMessage;

      // Find the original message that was reacted to
      const [originalMessage] = await query(
        `SELECT * FROM beta_conversation WHERE metaChatId = ? AND uid = ?`,
        [reaction.key.id, uid]
      );

      if (originalMessage) {
        // Update the reaction field in the original message
        await query(
          `UPDATE beta_conversation SET reaction = ? WHERE metaChatId = ? AND uid = ?`,
          [reaction.text, reaction.key.id, uid]
        );

        // Return null as we don't need to create a new message for reactions
        return { newMessage: null, chatId };
      }

      // If original message not found, log warning
      console.warn(
        `Original message ${reaction.key.id} not found for reaction`
      );
      return { newMessage: null, chatId };
    } else if (body.message.extendedTextMessage) {
      const extText = body.message.extendedTextMessage;
      msgContext = {
        type: "text",
        text: {
          body: extText.text,
          preview_url: true,
        },
      };
      if (extText.contextInfo?.quotedMessage) {
        referencedMessageData = extText.contextInfo.quotedMessage;
      }
    } else if (body.message.imageMessage) {
      const img = body.message.imageMessage;
      const downloadResult = await downloadMediaPromise(body, img.mimetype);
      msgContext = {
        type: "image",
        image: {
          link: `${process.env.FRONTENDURI}/meta-media/${
            downloadResult.success ? downloadResult.fileName : ""
          }`,
          caption: img.caption || "",
        },
      };
    } else if (body.message.videoMessage) {
      const vid = body.message.videoMessage;
      const downloadResult = await downloadMediaPromise(body, vid.mimetype);
      msgContext = {
        type: "video",
        video: {
          link: `${process.env.FRONTENDURI}/meta-media/${
            downloadResult.success ? downloadResult.fileName : ""
          }`,
          caption: vid.caption || "",
        },
      };
    } else if (body.message.contactMessage) {
      const contact = body.message.contactMessage;
      msgContext = {
        type: "contact",
        contact: {
          name: contact.displayName || "Unknown Contact",
          vcard: contact.vcard || "",
        },
      };
    } else if (body.message.audioMessage) {
      const aud = body.message.audioMessage;
      const downloadResult = await downloadMediaPromise(body, aud.mimetype);
      msgContext = {
        type: "audio",
        audio: {
          link: `${process.env.FRONTENDURI}/meta-media/${
            downloadResult.success ? downloadResult.fileName : ""
          }`,
        },
      };
    } else if (body.message.locationMessage) {
      msgContext = {
        type: "location",
        location: {
          latitude: body.message?.locationMessage?.degreesLatitude,
          longitude: body.message?.locationMessage?.degreesLongitude,
          name: body.message?.locationMessage?.name,
          address: body.message?.locationMessage?.address,
        },
      };
    } else if (body.message.documentWithCaptionMessage) {
      const doc =
        body.message.documentWithCaptionMessage.message.documentMessage;
      const downloadResult = await downloadMediaPromise(
        body,
        body?.message?.documentWithCaptionMessage?.message?.documentMessage?.mimetype?.replace(
          "application/x-javascript",
          "application/javascript"
        )
      );
      msgContext = {
        type: "document",
        document: {
          link: `${process.env.FRONTENDURI}/meta-media/${
            downloadResult.success ? downloadResult.fileName : ""
          }`,
          caption: doc.caption || doc.title || "",
        },
      };
      if (doc.contextInfo?.quotedMessage) {
        referencedMessageData = doc.contextInfo.quotedMessage;
      }
    } else {
      console.warn("Unsupported message type in Baileys webhook");
      return null;
    }

    // Determine context from quoted message if available
    let contextData = "";
    if (referencedMessageData?.stanzaId) {
      const [foundMsg] = await query(
        `SELECT * FROM beta_conversation WHERE metaChatId = ? AND uid = ?`,
        [referencedMessageData.stanzaId, uid]
      );
      contextData = foundMsg || referencedMessageData;
    } else if (referencedMessageData) {
      contextData = referencedMessageData;
    }

    // Create the new message object
    const newMessage = {
      type: msgContext.type,
      metaChatId: body.key.id,
      msgContext,
      reaction: "",
      timestamp: getCurrentTimestampInTimeZone(
        userFromMysql?.timezone || body.messageTimestamp
      ),
      senderName: body.pushName || "NA",
      senderMobile: body.key.remoteJid
        ? body.key.remoteJid.split("@")[0]
        : "NA",
      status: "",
      star: false,
      route: body.key?.fromMe ? "OUTGOING" : "INCOMING",
      context: contextData,
      origin: "qr",
    };

    // Save message to MySQL
    await saveMessageToConversation({
      uid,
      chatId,
      messageData: newMessage,
    });

    return { newMessage, chatId };
  } catch (err) {
    console.error("Error processing Baileys message:", err);
    return null;
  }
}

async function getUserDetails(sessionId) {
  try {
    const [instance] = await query(
      `SELECT * FROM instance WHERE uniqueId = ?`,
      [sessionId]
    );
    if (!instance) return null;

    const [user] = await query(`SELECT * FROM user WHERE uid = ?`, [
      instance.uid,
    ]);
    if (!user) return null;

    return { ...user, instance };
  } catch (err) {
    console.error("getUserDetails error:", err);
    return null;
  }
}

async function processMessageQr({
  type,
  message,
  sessionId,
  getSession,
  userData,
  uid,
}) {
  try {
    type === "update" && console.log("UPDATE ARRIVED");

    const userDetails = await getUserDetails(sessionId);
    if (!userDetails) {
      console.log("userDetails is null");
      return;
    }

    const instanceNumber = userDetails?.instance?.number;

    if (!instanceNumber || !message.key.remoteJid || !uid) {
      console.log("Details not found to update chat list");
      console.log({
        instanceNumber,
        senderMobile: message.key.remoteJid,
        uid,
      });
    }

    const chatId = getChatId({
      instanceNumber,
      senderMobile: message.key.remoteJid,
      uid,
    });
    const data = await processBaileysMsg({
      body: message,
      uid: uid,
      userFromMysql: userData,
      chatId,
    });

    // Update chat in MySQL with the latest message
    if (data?.newMessage) {
      await updateChatInMysql({
        chatId,
        uid: uid,
        senderName: data.newMessage.senderName,
        senderMobile: data.newMessage.senderMobile,
        actualMsg: data.newMessage,
        sessionId,
        getSession,
        jid: message?.remoteJid || message?.key?.remoteJid,
      });
    }

    return data;
  } catch (err) {
    console.error("processMessageQr error:", err);
    return null;
  }
}

module.exports = {
  processMessageQr,
};
