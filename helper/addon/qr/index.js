const fs = require("fs");
const path = require("path");
const pino = require("pino");
const makeWASocket = require("baileys").default;
const { getUrlInfo, downloadMediaMessage } = require("baileys");
const { toDataURL } = require("qrcode");
const { query } = require("../../../database/dbpromise");

const isSessionExists = () => false;
const createSession = async () => {};
const getSession = () => null;
const deleteSession = async () => {};
const getChatList = () => [];
const isExists = async () => false;
const sendMessage = async () => {};
const formatPhone = (phone) => phone;
const formatGroup = (group) => group;
const cleanup = () => {};
const init = () => {};
const getGroupData = async () => {};
const replaceWithRandom = (inputText) => inputText;
const checkQr = () => false;

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
