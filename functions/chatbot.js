const { query } = require("../database/dbpromise");
const moment = require("moment-timezone");
const fetch = require("node-fetch");
const { addON } = require("../env.js");
const fs = require("fs");
const { google } = require("googleapis");

async function authenticate(credentials) {
  const { client_email, private_key } = credentials;

  const auth = new google.auth.JWT(client_email, null, private_key, [
    "https://www.googleapis.com/auth/spreadsheets",
  ]);
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

async function getSheetByName(sheets, spreadsheetId, sheetName) {
  try {
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId,
    });

    const sheet = spreadsheet.data.sheets.find(
      (s) => s.properties.title === sheetName
    );

    if (!sheet) {
      return { exists: false };
    }

    const data = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:Z`,
    });

    return {
      exists: true,
      data: data.data.values || [],
      sheetId: sheet.properties.sheetId,
      properties: sheet.properties,
    };
  } catch (error) {
    console.error("Error getting sheet:", error.message);
    throw error;
  }
}

async function pushOrCreateSheet(sheets, spreadsheetId, sheetName, data) {
  try {
    // First check if sheet exists
    const sheetInfo = await getSheetByName(sheets, spreadsheetId, sheetName);

    if (!sheetInfo.exists) {
      // Create the sheet if it doesn't exist
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: sheetName,
                  gridProperties: {
                    rowCount: 1000,
                    columnCount: 26,
                  },
                },
              },
            },
          ],
        },
      });
      console.log(`Created new sheet: ${sheetName}`);
    }

    // Prepare data (convert object to array if needed)
    const values = Array.isArray(data) ? data : [Object.values(data)];

    // Push data to sheet
    const result = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      resource: { values },
    });

    return {
      success: true,
      updatedCells: result.data.updates.updatedCells,
      updatedRange: result.data.updates.updatedRange,
    };
  } catch (error) {
    console.error("Error in pushOrCreateSheet:", error.message);
    throw error;
  }
}

async function pushSpreadSheet({ authUrl, sheetName, sheetId, jsonData }) {
  try {
    const res = await fetch(authUrl);
    if (!res.ok) throw new Error("Failed to fetch service account JSON");
    const credsPath = await res.json();

    const spreadsheetId = sheetId;

    const sheets = await authenticate(credsPath);
    const sheetData = await getSheetByName(sheets, spreadsheetId, sheetName);
    console.log("Sheet exists:", sheetData.exists);

    const pushResult = await pushOrCreateSheet(
      sheets,
      spreadsheetId,
      sheetName,
      jsonData
    );

    console.log("Push result:", pushResult);
  } catch (err) {
    console.log(err);
  }
}

function readJSONFile(filePath, length) {
  try {
    console.log("HEY");
    // Check if the file exists
    if (!fs.existsSync(filePath)) {
      console.error("File not found:", filePath);
      return []; // Return empty array if file does not exist
    }

    // Read the file content
    let fileContent = fs.readFileSync(filePath, "utf8");

    // }\n]  }\n]

    if (fileContent?.endsWith("}\n]  }\n]")) {
      console.log("FOUND ENDS");
      console.log("Invalid JSON found, making it correct");
      fileContent = fileContent.replace("}\n]  }\n]", "\n}\n]");
      console.log("Correction done!");

      // Write the corrected JSON back to the file
      fs.writeFileSync(filePath, fileContent, "utf8");
      console.log("Corrected JSON has been written to the file");
    }

    // Remove invalid trailing characters if they exist
    if (fileContent?.endsWith("}\n]\n}\n]")) {
      console.log("FOUND ENDS");
      console.log("Invalid JSON found, making it correct");
      fileContent = fileContent.replace("}\n]\n}\n]", "\n}\n]");
      console.log("Correction done!");

      // Write the corrected JSON back to the file
      fs.writeFileSync(filePath, fileContent, "utf8");
      console.log("Corrected JSON has been written to the file");
    }

    // Try to parse the JSON
    let jsonArray;
    try {
      jsonArray = JSON.parse(fileContent);
    } catch (error) {
      console.error("Initial JSON parse error:", error.message);
      return []; // Return empty array if JSON is not valid
    }

    // Check if the parsed content is an array
    if (!Array.isArray(jsonArray)) {
      console.error("Invalid JSON format: not an array");
      return []; // Return empty array if JSON is not an array
    }

    // If length is provided, return only specified number of latest objects
    if (typeof length === "number" && length > 0) {
      return jsonArray.slice(-length);
    }

    return jsonArray; // Return all objects if length is not provided or invalid
  } catch (error) {
    console.error("Error reading JSON file:", error);
    return []; // Return empty array if there's an error
  }
}

const replaceJsonWithVar = (val, variables) => {
  console.log({ val, variables });
  if (typeof val === "string") {
    if (val.startsWith("{{{") && val.endsWith("}}}")) {
      const key = val.slice(3, -3).trim();
      const keys = key.split(".");
      let resolvedValue = variables;

      for (const k of keys) {
        resolvedValue = resolvedValue && resolvedValue[k];
      }

      return resolvedValue !== undefined ? resolvedValue : val;
    } else {
      return val;
    }
  }

  if (typeof val === "object" && val !== null) {
    const result = Array.isArray(val) ? [] : {};
    for (const key in val) {
      result[key] = replaceJsonWithVar(val[key], variables);
    }
    return result;
  }

  return val;
};

async function makeRequest({
  method,
  url,
  body = null, // Default to null if no body is provided
  headers = [],
  variables = {},
  k,
  conversationPath,
}) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // 20 seconds

    // Helper function to replace variable placeholders (including nested objects)
    const resolveValue = (val) => {
      if (
        typeof val === "string" &&
        val.startsWith("{{{") &&
        val.endsWith("}}}")
      ) {
        const key = val.slice(3, -3).trim(); // Extract key from {{{entireMsg.senderName}}}

        // Handle nested properties (e.g., entireMsg.senderName)
        const keys = key.split("."); // Split string to handle nested keys
        let resolvedValue = variables;

        for (const k of keys) {
          resolvedValue = resolvedValue && resolvedValue[k];
        }

        return resolvedValue !== undefined ? resolvedValue : val;
      }
      return val;
    };

    // Convert headers array to an object with resolved variables
    const headersObject = headers.reduce((acc, { key, value }) => {
      acc[key] = resolveValue(value);
      return acc;
    }, {});

    // Ensure Content-Type is application/json if body is present
    if (body && method !== "GET" && method !== "DELETE") {
      headersObject["Content-Type"] = "application/json";
    }

    // Modify body for POST request when condition is met
    let requestBody;
    if (
      method === "POST" &&
      parseInt(k?.data?.msgContent?.sendConversation?.msglength) > 0
    ) {
      console.log({ yessss: "YES" });
      const msgData = readJSONFile(
        conversationPath,
        parseInt(k?.data?.msgContent?.sendConversation?.msglength)
      );

      // If msgData is an array and its length is more than 0, add it to the body
      if (Array.isArray(msgData) && msgData.length > 0) {
        body = {
          ...body, // Keep the existing body content
          conversationArray: msgData, // Add the conversation data to the body
        };
        console.log({ msgData: JSON.stringify(msgData) });
      }
    }

    // Handle body if it's not null or empty
    if (method !== "GET" && method !== "DELETE") {
      if (body) {
        // If body is an array, process with .reduce()
        if (Array.isArray(body)) {
          requestBody = JSON.stringify(
            body.reduce((acc, { key, value }) => {
              acc[key] = resolveValue(value);
              return acc;
            }, {})
          );
        } else if (typeof body === "object" && Object.keys(body).length > 0) {
          // If body is an object and not empty
          requestBody = JSON.stringify(
            Object.keys(body).reduce((acc, key) => {
              acc[key] = resolveValue(body[key]);
              return acc;
            }, {})
          );
        } else {
          // If body is an empty object or null, leave requestBody as null
          requestBody = null;
        }
      } else {
        // If body is null or undefined, set requestBody to null
        requestBody = null;
      }
    }

    const config = {
      method,
      headers: headersObject,
      body: requestBody,
      signal: controller.signal,
    };

    const response = await fetch(url, config);
    clearTimeout(timeoutId);

    if (!response.ok) {
      return { success: false, msg: `HTTP error ${response.status}` };
    }

    const data = await response.json();

    // console.log({ data });

    if (typeof data === "object" || Array.isArray(data)) {
      return { success: true, data };
    } else {
      return { success: false, msg: "Invalid response format" };
    }
  } catch (error) {
    console.log(error);
    return { success: false, msg: error.message };
  }
}

// Function to check if a date has passed in a given timezone
function hasDatePassedInTimezone(timezone, date) {
  const givenDate = new Date(date); // Parses as local or ISO depending on format
  const now = new Date(); // Current system/server time
  return givenDate < now;
}

const msgType = [
  "TEXT",
  "IMAGE",
  "AUDIO",
  "VIDEO",
  "DOCUMENT",
  "BUTTON",
  "LIST",
  "LOCATION",
  "TAKE_INPUT",
];

const toolsType = [
  "ASSIGN_AGENT",
  "DISABLE_CHAT",
  "MAKE_REQUEST",
  "TAKE_INPUT",
  "SAVE_AS_VAR",
  "SPREADSHEET",
  "CONDITION",
];

const addonType = ["AI_BOT"];

async function checkIfDisabled(flow, senderNumber) {
  try {
    const parseDisableArr = flow?.prevent_list
      ? JSON.parse(flow?.prevent_list)
      : [];

    const extractMobileDataFromList = parseDisableArr.filter(
      (x) => x.mobile == senderNumber
    );

    if (extractMobileDataFromList.length > 0) {
      const scheduleDate = extractMobileDataFromList[0]?.timestamp
        ? new Date(extractMobileDataFromList[0]?.timestamp)
        : null;

      if (
        !hasDatePassedInTimezone(
          extractMobileDataFromList[0]?.timezone,
          scheduleDate
        )
      ) {
        return "STOP";
      }
    }
  } catch (err) {
    console.log("ERROR FOUND IN replyMessage in chatbot.js");
    console.log(err);
  }
}

async function replyMessage({
  uid,
  k,
  chatbotFromMysq,
  toName,
  senderNumber,
  sendMetaMsg,
  chatId,
  nodes,
  edges,
  incomingMsg,
  variables,
}) {
  try {
    // replacing variables global
    k.data.msgContent = returnAfterAddingVariable(k.data.msgContent, {
      senderName: toName,
      senderMsg: incomingMsg,
      senderMobile: senderNumber,
      ...variables,
    });

    const saveObj = {
      type:
        k?.type?.toLowerCase() === "take_input"
          ? "text"
          : k?.type?.toLowerCase(),
      metaChatId: "",
      msgContext: k?.data.msgContent,
      reaction: "",
      timestamp: "",
      senderName: toName,
      senderMobile: senderNumber,
      status: "sent",
      star: false,
      route: "OUTGOING",
    };

    // console.dir({ saveObj, k }, { depth: null });
    await sendMetaMsg({
      uid: uid,
      msgObj: k?.data.msgContent,
      toNumber: senderNumber,
      savObj: saveObj,
      chatId: chatId,
      chatbotFromMysq: chatbotFromMysq,
    });
  } catch (err) {
    console.log("ERROR FOUND IN replyMessage in chatbot.js");
    console.log(err);
  }
}

async function completeTools({
  uid,
  k,
  chatbotFromMysq,
  toName,
  senderNumber,
  sendMetaMsg,
  chatId,
  nodes,
  edges,
  flow,
  variables,
  flow_data,
  uniqueId,
  conversationPath,
  newMessage,
  incomingMsg,
  flowData,
}) {
  try {
    // assigning chat to agent
    if (k?.type == "ASSIGN_AGENT") {
      console.log({ email: k?.data?.msgContent?.agentEmail, chatId });

      if (k?.data?.msgContent?.agentEmail) {
        // checking if the chat was already assigned
        const checkIfAlreadyChatAsssigned = await query(
          `SELECT * FROM agent_chats WHERE owner_uid = ? AND uid = ? AND chat_id = ?`,
          [uid, k?.data?.msgContent?.agentObj?.uid, chatId]
        );

        console.log({ checkIfAlreadyChatAsssigned });
        if (checkIfAlreadyChatAsssigned?.length < 1) {
          await query(
            `INSERT INTO agent_chats (owner_uid, uid, chat_id) VALUES (?,?,?)`,
            [uid, k?.data?.msgContent?.agentObj?.uid, chatId]
          );
        }
      }
    }

    if (k?.type === "TAKE_INPUT") {
      if (flow_data?.id) {
        await query(`UPDATE flow_data SET other = ? WHERE uniqueId = ?`, [
          JSON.stringify(k),
          uniqueId,
        ]);
      } else {
        await query(
          `INSERT INTO flow_data (uid, uniqueId, other) VALUES (?,?,?)`,
          [uid, uniqueId, JSON.stringify(k)]
        );
      }
    }

    if (k?.type == "SAVE_AS_VAR") {
      const [getFlowData] = await query(
        `SELECT * FROM flow_data WHERE uniqueId = ?`,
        [uniqueId]
      );

      function createObjectFromFullPath(globalScope, variableName, fullPath) {
        try {
          let value;

          // Check if fullPath is a stringified JSON request like "JSON.stringify(previousMsg)"
          if (fullPath === "JSON.stringify(previousMsg)") {
            value = JSON.stringify(globalScope.previousMsg);
          } else {
            // Process the fullPath like a regular path
            value = fullPath.split(".").reduce((acc, key) => {
              if (acc && key in acc) return acc[key];
              throw new Error("Invalid path");
            }, globalScope);
          }

          return { [variableName]: value };
        } catch {
          return { [variableName]: "NA" };
        }
      }

      if (!getFlowData) {
        const varData = createObjectFromFullPath(
          { previousMsg: newMessage },
          k?.data?.variableName,
          k?.data?.keyToSave
        );
        await query(
          `INSERT INTO flow_data (uid, uniqueId, inputs, other) VALUES (?,?,?,?)`,
          [uid, uniqueId, JSON.stringify(varData), JSON.stringify(varData)]
        );
      } else {
        // Parse the old inputs to make sure you have a valid object
        const oldInputs = getFlowData?.inputs
          ? JSON.parse(getFlowData?.inputs)
          : {};

        // Create the new input based on the provided path
        const newInputs = createObjectFromFullPath(
          { previousMsg: newMessage },
          k?.data?.variableName,
          k?.data?.keyToSave
        );

        // Check if the variable name already exists in old inputs
        if (oldInputs.hasOwnProperty(k?.data?.variableName)) {
          // Check if the value of the variable is a stringified JSON
          try {
            const parsedOldValue = JSON.parse(oldInputs[k?.data?.variableName]);

            // If the old value is a stringified JSON, we directly replace the value
            if (typeof parsedOldValue === "object") {
              // If it's an object, merge it with the new value
              oldInputs[k?.data?.variableName] = {
                ...parsedOldValue,
                ...newInputs[k?.data?.variableName],
              };
            }
          } catch (e) {
            // If not stringified JSON, simply replace the value directly
            oldInputs[k?.data?.variableName] = newInputs[k?.data?.variableName];
          }
        } else {
          // If the variable doesn't exist, just add it to the old inputs
          oldInputs[k?.data?.variableName] = newInputs[k?.data?.variableName];
        }

        console.log({ newInputs });

        // Save the updated inputs
        await query(`UPDATE flow_data SET inputs = ? WHERE uniqueId = ?`, [
          JSON.stringify(oldInputs), // Make sure you're saving the object correctly
          uniqueId,
        ]);
      }

      // moving to the next connected node
      const findSourceFromEdge = edges?.filter((x) => x.source == k?.id);

      if (findSourceFromEdge?.length > 0) {
        for (const f of findSourceFromEdge) {
          const getNodeFromSource = nodes?.filter((x) => x.id == f?.target);

          for (const k of getNodeFromSource) {
            await destributeTaskFlow({
              uid,
              k,
              chatbotFromMysq,
              toName,
              senderNumber,
              sendMetaMsg,
              chatId,
              nodes,
              edges,
              variablesOld: {},
              flowData,
            });
          }
        }
      }
    }

    // if (k.type === "CONDITION") {
    //   function cleanValue(input) {
    //     const [first, ...rest] = input.split(" ");
    //     const cleanedFirst = first.split("_")[0];
    //     return [cleanedFirst, ...rest].join(" ");
    //   }

    //   const conditionStringValue = replacePlaceholders(k?.data?.stringValue, {
    //     senderMobile: senderNumber,
    //     senderName: toName,
    //     ...variables,
    //   });

    //   const cleanNodeId = cleanValue(k?.id);
    //   const newNodeId = JSON.stringify(incomingMsg)?.includes(
    //     conditionStringValue
    //   )
    //     ? `${cleanNodeId}_equal`
    //     : `${cleanNodeId}_notEqual`;

    //   console.log({ newNodeId });

    //   // moving to the next connected node
    //   const findSourceFromEdge = edges?.filter(
    //     (x) => x.sourceHandle == newNodeId
    //   );

    //   if (findSourceFromEdge?.length > 0) {
    //     for (const f of findSourceFromEdge) {
    //       const getNodeFromSource = nodes?.filter((x) => x.id == f?.target);

    //       for (const k of getNodeFromSource) {
    //         await destributeTaskFlow({
    //           uid,
    //           k,
    //           chatbotFromMysq,
    //           toName,
    //           senderNumber,
    //           sendMetaMsg,
    //           chatId,
    //           nodes,
    //           edges,
    //           variablesOld: {},
    //         });
    //       }
    //     }
    //   }
    // }

    if (k.type === "CONDITION") {
      function cleanValue(input) {
        const [first, ...rest] = input.split(" ");
        const cleanedFirst = first.split("_")[0];
        return [cleanedFirst, ...rest].join(" ");
      }

      const conditionStringValue = replacePlaceholders(k?.data?.stringValue, {
        senderMobile: senderNumber,
        senderName: toName,
        ...variables,
      });

      const cleanNodeId = cleanValue(k?.id);

      const msgToCompare = k?.data?.caseSensitive
        ? JSON.stringify(incomingMsg)
        : JSON.stringify(incomingMsg).toLowerCase();

      const conditionToCompare = k?.data?.caseSensitive
        ? conditionStringValue
        : conditionStringValue?.toLowerCase();

      const newNodeId = msgToCompare.includes(conditionToCompare)
        ? `${cleanNodeId}_equal`
        : `${cleanNodeId}_notEqual`;

      console.log({ newNodeId });

      // moving to the next connected node
      const findSourceFromEdge = edges?.filter(
        (x) => x.sourceHandle == newNodeId
      );

      if (findSourceFromEdge?.length > 0) {
        for (const f of findSourceFromEdge) {
          const getNodeFromSource = nodes?.filter((x) => x.id == f?.target);

          for (const k of getNodeFromSource) {
            await destributeTaskFlow({
              uid,
              k,
              chatbotFromMysq,
              toName,
              senderNumber,
              sendMetaMsg,
              chatId,
              nodes,
              edges,
              variablesOld: {},
              flowData,
            });
          }
        }
      }
    }

    if (k?.type === "SPREADSHEET") {
      const { authUrl, authLabel, jsonData, sheetName, sheetId } = k.data;
      if (authUrl && authLabel && jsonData && sheetName && sheetId) {
        await pushSpreadSheet({
          authUrl,
          sheetName,
          sheetId,
          jsonData: replaceJsonWithVar(jsonData, {
            ...variables,
            senderName: toName,
            senderMobile: senderNumber,
          }),
        });

        // moving to the next connected node
        const findSourceFromEdge = edges?.filter((x) => x.source == k?.id);

        if (findSourceFromEdge?.length > 0) {
          for (const f of findSourceFromEdge) {
            const getNodeFromSource = nodes?.filter((x) => x.id == f?.target);

            for (const k of getNodeFromSource) {
              await destributeTaskFlow({
                uid,
                k,
                chatbotFromMysq,
                toName,
                senderNumber,
                sendMetaMsg,
                chatId,
                nodes,
                edges,
                variablesOld: {},
                flowData,
              });
            }
          }
        }
      } else {
        console.log("In the spreadsheet node all required fields not found");
      }
    }

    // adding disabling chat to mysql for chat
    if (k?.type == "DISABLE_CHAT") {
      console.log("DISABLE_CHAT");
      const getChat = await query(
        `SELECT * FROM chats WHERE chat_id = ? AND uid = ?`,
        [chatId, uid]
      );

      if (getChat?.length > 0) {
        const oldObj = getChat[0]?.prevent_list
          ? JSON.parse(getChat[0]?.prevent_list)
          : [];

        const now = new Date();
        now.setHours(now.getHours() + Number(k?.data?.hours || 0));
        now.setMinutes(now.getMinutes() + Number(k?.data?.minutes || 0));
        const timestamp = now.getTime(); // capture the timestamp in milliseconds

        const newObj = {
          mobile: senderNumber,
          timestamp: k?.data?.hours
            ? timestamp
            : k?.data?.msgContent?.timestamp,
          timezone: k?.data?.msgContent?.timezone,
        };

        const finalArr = [...oldObj, newObj];

        console.log({ finalArr, flow, uid });

        await query(
          `UPDATE flow SET prevent_list = ? WHERE uid = ? AND flow_id = ?`,
          [JSON.stringify(finalArr), uid, flow?.flow_id]
        );

        console.log(
          senderNumber,
          "was moved to disable list till",
          k?.data?.msgContent?.timestamp
        );
      }
    }

    // making a request
    if (k?.type == "MAKE_REQUEST") {
      const msgContent = k?.data?.msgContent;

      const urll = replacePlaceholders(msgContent?.url, {
        senderMobile: senderNumber,
        senderName: toName,
        ...variables,
      });

      if (msgContent?.response) {
        const resp = await makeRequest({
          method: msgContent?.type,
          url: urll,
          body: msgContent?.body,
          headers: msgContent?.headers,
          variables,
          k,
          conversationPath,
        });

        // console.log({
        //   resp,
        // });

        const findSourceFromEdge = edges?.filter((x) => x.source == k?.id);

        if (findSourceFromEdge?.length > 0) {
          for (const f of findSourceFromEdge) {
            const getNodeFromSource = nodes?.filter((x) => x.id == f?.target);

            for (const k of getNodeFromSource) {
              k.data.msgContent = returnAfterAddingVariable(
                k.data.msgContent,
                resp?.data
              );

              await destributeTaskFlow({
                uid,
                k,
                chatbotFromMysq,
                toName,
                senderNumber,
                sendMetaMsg,
                chatId,
                nodes,
                edges,
                variablesOld: { ...variables, ...resp, ...resp.data },
                flowData,
              });
            }
          }
        }
      } else {
        console.log(
          "There was no connected node found in the MAKE_REQUEST tool"
        );
      }
    }
  } catch (err) {
    console.log("ERROR FOUND IN completeTools in chatbot.js");
    console.log(err);
  }
}

async function completeAddon({
  uid,
  k,
  chatbotFromMysq,
  toName,
  senderNumber,
  sendMetaMsg,
  chatId,
  nodes,
  edges,
  incomingMsg,
  destributeTaskFlow,
}) {
  try {
    if (k?.type == "AI_BOT" && addON?.includes("AI_BOT")) {
      console.log("Came to if");
      const { singleReplyAi } = require("./ai.js");
      console.log(`singleReplyAi ran`);

      // adding delay
      // await new Promise((r) => setTimeout(r, 3000));

      await singleReplyAi({
        uid,
        k,
        chatbotFromMysq,
        toName,
        senderNumber,
        sendMetaMsg,
        chatId,
        nodes,
        edges,
        incomingMsg,
        destributeTaskFlow,
      });
    }
  } catch (err) {
    console.log(err);
  }
}

async function manupulateAiForAll({
  uid,
  k,
  chatbotFromMysq,
  toName,
  senderNumber,
  sendMetaMsg,
  chatId,
  nodes,
  edges,
  incomingMsg,
  flow,
  flow_data,
}) {
  try {
    const aiArr = flow?.ai_list ? JSON.parse(flow?.ai_list) : [];

    const findIncomingNumber = aiArr?.filter(
      (x) => x.senderNumber == senderNumber
    );

    // Checking if assigned to AI
    if (k?.data?.msgContent?.assignAi) {
      console.log("this chat is assigned to ai");
      if (findIncomingNumber?.length < 1) {
        // Updating MySQL flow and adding sender number to AI array
        const pusObj = {
          senderNumber: senderNumber,
          k,
          toName,
        };
        const newArr = [...aiArr, pusObj];

        await query(
          `UPDATE flow SET ai_list = ? WHERE uid = ? AND flow_id = ?`,
          [JSON.stringify(newArr), uid, flow?.flow_id]
        );

        return "NO_CHANGE"; // No modification needed for k
      }
    } else {
      if (findIncomingNumber?.length > 0) {
        return "MODIFY"; // Indicate that k should be modified
      }
    }

    return "NO_CHANGE"; // Default return value
  } catch (err) {
    console.log("Error found in manupulateAiForAll() in chatbot.js", err);
    return "NO_CHANGE"; // Return to continue flow even if there's an error
  }
}

async function returnVariables({
  uniqueId,
  k,
  incomingMsg,
  nodes,
  edges,
  newMessage,
  variablesOld,
  conversationPath,
}) {
  // getting the flow data
  const [flow_data] = await query(
    `SELECT * FROM flow_data WHERE uniqueId = ?`,
    [uniqueId]
  );

  if (flow_data && Object.keys(flow_data).length > 0) {
    let inputs = flow_data?.inputs ? JSON.parse(flow_data.inputs) : {};

    // console.dir({ k }, { depth: null });
    const savedNode = JSON.parse(flow_data.other) || {};

    if (flow_data?.other) {
      // Merge new variable correctly into inputs
      inputs = { ...inputs, [savedNode?.data?.variableName]: incomingMsg };

      // Update the database with the new inputs and clear the 'other' column
      await query(
        `UPDATE flow_data SET inputs = ?, other = ? WHERE uniqueId = ?`,
        [JSON.stringify(inputs), null, uniqueId]
      );

      const findSourceFromEdge = edges?.find((x) => x.source == savedNode?.id);
      if (findSourceFromEdge) {
        k = nodes?.find((x) => x.id == findSourceFromEdge?.target) || {};
      }
    }

    return {
      variables: { ...inputs, ...variablesOld, previousMsg: newMessage },
      flow_data,
      updatedK: k,
    };
  } else {
    return { variables: {}, flow_data: null, updatedK: k };
  }
}

async function destributeTaskFlow({
  uid,
  k,
  chatbotFromMysq,
  toName,
  senderNumber,
  sendMetaMsg,
  chatId,
  nodes,
  edges,
  incomingMsg,
  flowData,
  newMessage,
  variablesOld = {},
  conversationPath = null,
}) {
  // console.log(JSON.stringify({ k }));
  console.log("destributeTaskFlow");
  const uniqueId = `${uid}-${senderNumber}-${chatId}`;
  const { variables, flow_data, updatedK } = await returnVariables({
    uniqueId,
    k,
    incomingMsg,
    nodes,
    edges,
    newMessage,
    variablesOld,
    conversationPath,
  });

  k = updatedK;

  let taskName = k?.type || k?.nodeType;

  // getting flow data
  const [flow] = await query(`SELECT * FROM flow WHERE flow_id = ?`, [
    flowData?.flow_id,
  ]);

  // returning fucntion if the number is in prevent list
  const checkOnce = await checkIfDisabled(flow, senderNumber);
  if (checkOnce === "STOP") {
    return;
  }

  const check = await manupulateAiForAll({
    uid,
    k,
    chatbotFromMysq,
    toName,
    senderNumber,
    sendMetaMsg,
    chatId,
    nodes,
    edges,
    incomingMsg,
    flow,
    flow_data,
  });

  if (check == "MODIFY") {
    const aiArr = flow?.ai_list ? JSON.parse(flow?.ai_list) : [];
    const findIncomingNumber = aiArr?.filter(
      (x) => x.senderNumber == senderNumber
    );
    const aiObj = findIncomingNumber[0];
    k = aiObj?.k;
  }

  taskName = k?.type || k?.nodeType;

  // console.dir({ kkkkk: k }, { depth: null });
  console.log({ taskName });

  // if the node type is message
  if (msgType?.includes(taskName)) {
    await replyMessage({
      uid,
      k,
      chatbotFromMysq,
      toName,
      senderNumber,
      sendMetaMsg,
      chatId,
      nodes,
      edges,
      incomingMsg,
      variables,
      flowData,
    });
  }

  // if the node type is addon
  if (addonType.includes(taskName)) {
    console.log("Going to completeAddon");
    await completeAddon({
      uid,
      k,
      chatbotFromMysq,
      toName,
      senderNumber,
      sendMetaMsg,
      chatId,
      nodes,
      edges,
      incomingMsg,
      destributeTaskFlow,
    });
  }

  // if the node type is tools
  if (toolsType?.includes(taskName)) {
    await completeTools({
      uid,
      k,
      chatbotFromMysq,
      toName,
      senderNumber,
      sendMetaMsg,
      chatId,
      nodes,
      edges,
      flow,
      variables,
      flow_data,
      uniqueId,
      conversationPath,
      newMessage,
      incomingMsg,
      flowData,
    });
  }
}

function returnAfterAddingVariable(msgContent, response) {
  let returnObj;
  if (msgContent.type == "text") {
    returnObj = {
      type: "text",
      text: {
        preview_url: true,
        body: replacePlaceholders(msgContent?.text?.body, response),
      },
    };
  } else if (msgContent.type == "video") {
    returnObj = {
      type: "video",
      video: {
        link: replacePlaceholders(msgContent?.video?.link, response),
        caption: replacePlaceholders(msgContent?.video?.caption, response),
      },
    };
  } else if (msgContent.type == "location") {
    returnObj = {
      type: "location",
      location: {
        latitude: msgContent?.location?.latitude,
        longitude: msgContent?.location?.longitude,
        name: replacePlaceholders(msgContent?.location?.name, response),
        address: replacePlaceholders(msgContent?.location?.address, response),
      },
    };
  } else if (
    msgContent.type == "interactive" &&
    msgContent?.interactive?.type == "list"
  ) {
    returnObj = {
      type: "interactive",
      interactive: {
        type: "list",
        header: {
          type: "text",
          text: replacePlaceholders(
            msgContent.interactive.header.text,
            response
          ),
        },
        body: {
          text: replacePlaceholders(msgContent.interactive.body.text, response),
        },
        footer: {
          text: replacePlaceholders(
            msgContent.interactive.footer.text,
            response
          ),
        },
        action: msgContent.interactive.action,
      },
    };
  } else if (msgContent.type == "image") {
    returnObj = {
      type: "image",
      image: {
        link: replacePlaceholders(msgContent.image.link, response),
        caption: replacePlaceholders(msgContent.image.caption, response),
      },
    };
  } else if (msgContent.type == "document") {
    returnObj = {
      type: "document",
      document: {
        link: replacePlaceholders(msgContent.document.link, response),
        caption: replacePlaceholders(msgContent.document.caption, response),
      },
    };
  } else if (
    msgContent.type == "interactive" &&
    msgContent.interactive.type == "button"
  ) {
    returnObj = {
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: replacePlaceholders(msgContent.interactive.body.text, response),
        },
        action: msgContent.interactive.action,
      },
    };
  } else if (msgContent.type == "audio") {
    returnObj = {
      type: "audio",
      audio: {
        link: replacePlaceholders(msgContent.audio.link, response),
      },
    };
  } else if (msgContent.type == "take_input") {
    returnObj = {
      type: "text",
      text: {
        preview_url: true,
        body: replacePlaceholders(msgContent?.text?.body, response),
      },
    };
  }
  return returnObj;
}

function replacePlaceholders(template, data) {
  return template.replace(/{{{([^}]+)}}}/g, (match, key) => {
    key = key.trim();

    // First, check if the exact key exists in `data`
    if (Object.prototype.hasOwnProperty.call(data, match)) {
      return data[match]; // Directly return the value mapped to `{{{nameX}}}`
    }

    // Handle `JSON.stringify()` calls
    if (key.startsWith("JSON.stringify(") && key.endsWith(")")) {
      const innerKey = key.slice(15, -1).trim();
      const keys = innerKey.split(/[\.\[\]]/).filter(Boolean);

      let value = data;
      for (const k of keys) {
        if (
          value &&
          (Array.isArray(value)
            ? value[parseInt(k, 10)] !== undefined
            : Object.prototype.hasOwnProperty.call(value, k))
        ) {
          value = Array.isArray(value) ? value[parseInt(k, 10)] : value[k];
        } else {
          return "NA";
        }
      }

      return JSON.stringify(value);
    }

    // Split the key to handle both array and object properties
    const keys = key.split(/[\.\[\]]/).filter(Boolean);
    let value = data;

    for (const k of keys) {
      if (
        value &&
        (Array.isArray(value)
          ? value[parseInt(k, 10)] !== undefined
          : Object.prototype.hasOwnProperty.call(value, k))
      ) {
        value = Array.isArray(value) ? value[parseInt(k, 10)] : value[k];
      } else {
        return "NA"; // Return 'NA' if key or index is not found
      }
    }

    return value !== undefined ? value : "NA"; // Return 'NA' if value is undefined
  });
}

module.exports = { destributeTaskFlow };
