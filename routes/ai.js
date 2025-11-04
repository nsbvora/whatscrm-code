const router = require("express").Router();
const { query } = require("../database/dbpromise.js");
const randomstring = require("randomstring");
const validateUser = require("../middlewares/user.js");
const { check, validationResult } = require("express-validator");
const {
  getRecentMessages,
  suggestReplyWithOpenAI,
  suggestReplyWithGemini,
  suggestReplyWithDeepseek,
  translateWithOpenAI,
  translateWithGemini,
  translateWithDeepseek,
} = require("../functions/function.js");

router.post(
  "/translate",
  [
    check("text", "Text is required").notEmpty(),
    check("targetLanguage", "Target language is required").notEmpty(),
    check("provider", "AI provider is required").notEmpty(),
    check("apiKey", "API key is required").notEmpty(),
  ],
  validateUser,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { text, targetLanguage, provider, apiKey } = req.body;

    try {
      let translatedText = "";

      switch (provider) {
        case "openai":
          translatedText = await translateWithOpenAI(
            text,
            targetLanguage,
            apiKey
          );
          break;
        case "gemini":
          translatedText = await translateWithGemini(
            text,
            targetLanguage,
            apiKey
          );
          break;
        case "deepseek":
          translatedText = await translateWithDeepseek(
            text,
            targetLanguage,
            apiKey
          );
          break;
        default:
          return res.status(400).json({
            success: false,
            message: "Unsupported AI provider",
          });
      }

      return res.json({
        success: true,
        translatedText,
      });
    } catch (error) {
      console.error("Translation error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Translation failed",
      });
    }
  }
);

router.post(
  "/suggest_reply",
  [
    check("chatId", "Chat ID is required").notEmpty(),
    check("provider", "AI provider is required").notEmpty(),
    check("apiKey", "API key is required").notEmpty(),
  ],
  validateUser,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { chatId, lastMessage, provider, apiKey } = req.body;
    const { uid } = req.decode;

    try {
      // Get recent conversation messages for context
      const recentMessages = await getRecentMessages(chatId, uid, 5);

      let suggestion = "";

      switch (provider) {
        case "openai":
          suggestion = await suggestReplyWithOpenAI(
            recentMessages,
            lastMessage,
            apiKey
          );
          break;
        case "gemini":
          suggestion = await suggestReplyWithGemini(
            recentMessages,
            lastMessage,
            apiKey
          );
          break;
        case "deepseek":
          suggestion = await suggestReplyWithDeepseek(
            recentMessages,
            lastMessage,
            apiKey
          );
          break;
        default:
          return res.status(400).json({
            success: false,
            message: "Unsupported AI provider",
          });
      }

      return res.json({
        success: true,
        suggestion,
      });
    } catch (error) {
      console.error("Suggestion error:", error);
      return res.status(500).json({
        success: false,
        message: error.message || "Failed to generate suggestion",
      });
    }
  }
);

module.exports = router;
