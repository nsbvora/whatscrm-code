const fs = require("fs");
const path = require("path");
const { query } = require("../../database/dbpromise");
const fetch = require("node-fetch");
const mime = require("mime-types");
const moment = require("moment-timezone");

function mergeArraysWithPhonebook(chatArray, phonebookArray) {
  // Iterate through the chat array and enrich with phonebook data
  return chatArray.map((chat) => {
    // Find matching phonebook entry where sender_mobile matches mobile
    const phonebookEntry = phonebookArray.find(
      (phonebook) => phonebook.mobile === chat.sender_mobile
    );

    // Add phonebook data if a match is found
    return {
      ...chat,
      phonebook: phonebookEntry || null, // Add phonebook data or null if no match
    };
  });
}

function extractFileName(url) {
  try {
    const decodedUrl = decodeURIComponent(url.split("?")[0]); // Remove query params
    return decodedUrl.substring(decodedUrl.lastIndexOf("/") + 1);
  } catch (error) {
    console.error("Error extracting file name:", error.message);
    return null;
  }
}

async function fetchImageAsBase64(url) {
  try {
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Failed to fetch image: ${response.status}`);

    const buffer = await response.buffer();
    const base64Image = `data:${response.headers.get(
      "content-type"
    )};base64,${buffer.toString("base64")}`;

    return base64Image;
  } catch (error) {
    console.error("Error fetching image:", error.message);
    return null;
  }
}

function timeoutPromise(promise, ms) {
  const timeout = new Promise(
    (resolve) => setTimeout(() => resolve(null), ms) // Instead of rejecting, resolve null
  );
  return Promise.race([promise, timeout]);
}

function extractObjFromChatId(str) {
  const parts = str.split("_");

  if (parts.length < 3) {
    return null; // Not enough parts to extract
  }

  return {
    fromNumber: parts[0],
    toNumber: parts[1],
    uid: parts[2],
  };
}

async function getSessionIdFromChatIdQr(str) {
  const obj = extractObjFromChatId(str);
  const sessionId = await query(
    `SELECT * FROM instance WHERE number = ? AND uid = ?`,
    [obj.fromNumber, obj.uid]
  );
  return sessionId[0]?.uniqueId || "na";
}

function extractPhoneNumber(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)(?=:|\@)/);
  return match ? match[1] : null;
}

function extractFinalNumber(chatInfo) {
  try {
    const otherData = JSON.parse(chatInfo?.origin_instance_id);
    const number = extractPhoneNumber(otherData?.id);
    return number;
  } catch (error) {
    return null;
  }
}

async function deleteMediaFromConversation({
  mediaFolderPath,
  type,
  uid,
  chatId,
  conversationData,
}) {
  try {
    switch (type) {
      case "media":
        conversationData.filter((msg) => {
          if (["image", "video", "document", "audio"].includes(msg.type)) {
            // Collect file link to delete
            const msgContext = JSON.parse(msg.msgContext);
            const mediaLink = msgContext[msg.type]?.link;
            if (mediaLink) {
              const filePath = path.join(
                mediaFolderPath,
                mediaLink.split("/").pop()
              );
              // Delete the file
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`Deleted file: ${filePath}`);
              } else {
                console.warn(`File not found: ${filePath}`);
              }
            }
          }
        });

        console.log("Media messages removed, and JSON updated successfully.");
        break;

      case "clear":
        // Handle "clear" type: Clear the entire conversation JSON
        await query(
          `DELETE FROM beta_conversation WHERE chat_id = ? AND uid = ?`,
          [chatId, uid]
        );
        console.log("Conversation JSON cleared successfully.");
        break;

      case "delete":
        // Handle "delete" type: Delete the JSON file
        await query(
          `DELETE FROM beta_conversation WHERE chat_id = ? AND uid = ?`,
          [chatId, uid]
        );
        console.log("Conversation JSON file deleted successfully.");
        break;

      default:
        console.error(
          "Invalid type provided. Use 'media', 'clear', or 'delete'."
        );
    }
  } catch (error) {
    console.error("Error processing conversation JSON:", error.message);
  }
}

function returnMsgObjAfterAddingKey(overrides = {}) {
  const defaultObj = {
    type: "text",
    metaChatId: "",
    msgContext: { type: "text", text: { preview_url: true, body: "hey yo" } },
    reaction: "",
    timestamp: "",
    senderName: "codeyon.com",
    senderMobile: "918430088300",
    status: "",
    star: false,
    route: "OUTGOING",
    context: "",
    origin: "meta",
    err: "",
  };

  // Merge overrides with the default object
  return { ...defaultObj, ...overrides };
}

async function sendMetaMsg({ uid, to, msgObj }) {
  try {
    const [api] = await query(`SELECT * FROM meta_api WHERE uid = ?`, [uid]);
    if (!api || !api?.access_token || !api?.business_phone_number_id) {
      return { success: false, msg: "Please add your meta API keys" };
    }

    function formatNumber(number) {
      return number?.replace("+", "");
    }

    const waToken = api?.access_token;
    const waNumId = api?.business_phone_number_id;

    const url = `https://graph.facebook.com/v17.0/${waNumId}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: formatNumber(to),
      ...msgObj,
    };

    console.log({
      uid,
      to,
      msgObj,
      format: formatNumber(to),
    });

    console.log(JSON.stringify(payload));

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${waToken}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (data?.error) {
      return { success: false, msg: data?.error?.message };
    }

    if (data?.messages[0]?.id) {
      const metaMsgId = data?.messages[0]?.id;
      return { success: true, id: metaMsgId };
    } else {
      return { success: false, msg: JSON.stringify(data) };
    }
  } catch (err) {
    return { success: false, msg: err?.toString() };
  }
}

function setQrMsgObj(obj) {
  if (!obj || typeof obj !== "object") return null;

  switch (obj.type) {
    case "text":
      return { text: obj.text?.body || "" };
    case "image":
      return {
        image: {
          url: obj?.image?.link,
        },
        caption: obj?.image?.caption || null,
        jpegThumbnail: fetchImageAsBase64(obj?.image?.link),
      };

    case "video":
      return {
        video: {
          url: obj?.video?.link,
        },
        caption: obj?.video?.caption || null,
      };

    case "audio":
      const mp3FileName = extractFileName(obj?.audio?.link);
      const mp3FilePath = `${__dirname}/../../client/public/media/${mp3FileName}`;

      return {
        audio: {
          url: mp3FilePath,
        },
        ptt: true,
        mimetype: "audio/aac",
      };

    case "document":
      return {
        document: {
          url: obj?.document?.link,
        },
        caption: obj?.document?.caption || null,
        fileName: extractFileName(obj?.document?.link),
      };

    case "location":
      return {
        location: {
          degreesLatitude: obj?.location?.latitude,
          degreesLongitude: obj?.location?.longitude,
          name: obj?.location?.name,
        },
      };

    default:
      return null;
  }
}

async function sendQrMsg({ uid, to, msgObj, chatInfo }) {
  try {
    const sessionMobileNumber = extractFinalNumber(chatInfo);
    if (!sessionMobileNumber) {
      return {
        success: false,
        msg: "Session is not ready yet to send message please wait for few seconds and refresh the page to continue",
      };
    }

    const qrObj = setQrMsgObj(msgObj);

    if (!qrObj) {
      return { success: false, msg: "Invalid message type" };
    }

    // getting session
    const sessionId = await getSessionIdFromChatIdQr(chatInfo?.chat_id);

    const {
      getSession,
      formatGroup,
      formatPhone,
    } = require("../../helper/addon/qr");

    console.log({ sessionId });

    // extracting session from local
    const session = await timeoutPromise(getSession(sessionId || "a"), 60000);
    if (!session) {
      return { success: false, msg: "Session not found locally" };
    }

    const jid = chatInfo?.isGroup ? formatGroup(to) : formatPhone(to);

    console.log({ qrObj, jid });

    const send = await timeoutPromise(session?.sendMessage(jid, qrObj), 60000);

    const msgId = send?.key?.id;
    if (!msgId) {
      return {
        success: false,
        msg: `Could not send message: ${send?.toString()}`,
      };
    } else {
      return { success: true, id: msgId };
    }
  } catch (err) {
    console.log(err);
    return { success: false, msg: err?.toString() };
  }
}

async function sendNewMessage({ sessionId, message, number }) {
  try {
    const {
      getSession,
      formatGroup,
      formatPhone,
      isExists,
    } = require("../../helper/addon/qr");

    const session = await getSession(sessionId);

    if (!session) {
      return {
        success: false,
        msg: "Session not found, Pleasew check if your WhatsApp account is connected",
      };
    }

    const msgObj = {
      text: message,
    };

    const jid = formatPhone(number);

    const checkNumber = await isExists(session, jid, false);

    console.log({ checkNumber: checkNumber, jid });

    if (!checkNumber) {
      return {
        success: false,
        msg: "This number is not found on WhatsApp",
      };
    }

    const send = await timeoutPromise(session?.sendMessage(jid, msgObj), 60000);
    const msgId = send?.key?.id;
    if (!msgId) {
      return {
        success: false,
        msg: `Could not send message: ${send?.toString()}`,
      };
    } else {
      return { success: true, id: msgId, sessionData: session };
    }
  } catch (err) {
    console.log(err);
    return { success: false, msg: err?.toString() || "Could not send message" };
  }
}

function getCurrentTimestampInTimeZone(timezone) {
  const currentTimeInZone = moment.tz(timezone);
  const currentTimestampInSeconds = Math.round(
    currentTimeInZone.valueOf() / 1000
  );

  return currentTimestampInSeconds;
}

module.exports = {
  mergeArraysWithPhonebook,
  deleteMediaFromConversation,
  returnMsgObjAfterAddingKey,
  sendMetaMsg,
  sendQrMsg,
  getCurrentTimestampInTimeZone,
  sendNewMessage,
  extractPhoneNumber,
  setQrMsgObj,
};
