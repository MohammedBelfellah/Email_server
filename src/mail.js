import { config } from "./config.js";

function splitHeadersAndBody(rawEmail) {
  const normalized = rawEmail.replace(/\r\n/g, "\n");
  const splitAt = normalized.indexOf("\n\n");

  if (splitAt === -1) {
    return { headerText: normalized, body: "" };
  }

  return {
    headerText: normalized.slice(0, splitAt),
    body: normalized.slice(splitAt + 2)
  };
}

function parseHeaders(headerText) {
  const headers = new Map();
  let currentName = "";

  for (const line of headerText.split("\n")) {
    if (/^\s/.test(line) && currentName) {
      headers.set(currentName, `${headers.get(currentName)} ${line.trim()}`);
      continue;
    }

    const index = line.indexOf(":");
    if (index === -1) {
      continue;
    }

    currentName = line.slice(0, index).trim().toLowerCase();
    headers.set(currentName, line.slice(index + 1).trim());
  }

  return headers;
}

function getContentTypeInfo(value = "") {
  const parts = String(value)
    .split(";")
    .map((part) => part.trim());
  const type = (parts.shift() || "text/plain").toLowerCase();
  const params = {};

  for (const part of parts) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }

    const key = part.slice(0, index).trim().toLowerCase();
    const rawValue = part.slice(index + 1).trim();
    params[key] = rawValue.replace(/^"|"$/g, "");
  }

  return { type, params };
}

function decodeQuotedPrintable(value) {
  return value
    .replace(/=\n/g, "")
    .replace(/=([a-fA-F0-9]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeBody(body, headers) {
  const encoding = (headers.get("content-transfer-encoding") || "").toLowerCase();

  if (encoding.includes("base64")) {
    try {
      return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8");
    } catch {
      return body;
    }
  }

  if (encoding.includes("quoted-printable")) {
    return decodeQuotedPrintable(body);
  }

  return body;
}

function decodeMimeWords(value) {
  return String(value || "").replace(/=\?([^?]+)\?([bqBQ])\?([^?]+)\?=/g, (_, charset, encoding, text) => {
    if (!/^utf-?8$/i.test(charset)) {
      return text;
    }

    if (encoding.toLowerCase() === "b") {
      return Buffer.from(text, "base64").toString("utf8");
    }

    return decodeQuotedPrintable(text.replaceAll("_", " "));
  });
}

function extractEmail(value) {
  const match = String(value || "").match(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+/);
  return match ? match[0].toLowerCase() : "";
}

function splitMultipart(body, boundary) {
  if (!boundary) {
    return [];
  }

  const marker = `--${boundary}`;
  const endMarker = `--${boundary}--`;
  const parts = [];
  let current = [];
  let insidePart = false;

  for (const line of body.split("\n")) {
    const trimmed = line.trim();

    if (trimmed === marker || trimmed === endMarker) {
      if (insidePart && current.length) {
        parts.push(current.join("\n").replace(/\n$/, ""));
      }

      current = [];
      insidePart = trimmed !== endMarker;
      continue;
    }

    if (insidePart) {
      current.push(line);
    }
  }

  return parts;
}

function parseBodyParts(body, headers) {
  const { type, params } = getContentTypeInfo(headers.get("content-type"));

  if (type.startsWith("multipart/")) {
    const result = { textBody: "", htmlBody: "" };

    for (const part of splitMultipart(body, params.boundary)) {
      const { headerText, body: partBody } = splitHeadersAndBody(part);
      const partHeaders = parseHeaders(headerText);
      const parsedPart = parseBodyParts(partBody, partHeaders);

      if (!result.textBody && parsedPart.textBody) {
        result.textBody = parsedPart.textBody;
      }

      if (!result.htmlBody && parsedPart.htmlBody) {
        result.htmlBody = parsedPart.htmlBody;
      }
    }

    return result;
  }

  const decodedBody = decodeBody(body, headers).trim();

  if (type.includes("text/html")) {
    return { textBody: "", htmlBody: decodedBody };
  }

  if (type.includes("text/plain")) {
    return { textBody: decodedBody, htmlBody: "" };
  }

  return { textBody: decodedBody, htmlBody: "" };
}

function findRecipient(headers, fallbackRecipient = "") {
  const headerRecipient =
    extractEmail(headers.get("delivered-to")) ||
    extractEmail(headers.get("x-original-to")) ||
    extractEmail(headers.get("to"));

  const fallback = extractEmail(fallbackRecipient);

  if (fallback) {
    return fallback;
  }

  return headerRecipient;
}

export function parseRawEmail(rawEmail, options = {}) {
  const { headerText, body } = splitHeadersAndBody(String(rawEmail || ""));
  const headers = parseHeaders(headerText);
  const parsedBody = parseBodyParts(body, headers);
  const toEmail = findRecipient(headers, options.recipient);

  return {
    toEmail,
    fromEmail: extractEmail(headers.get("from")),
    subject: decodeMimeWords(headers.get("subject") || ""),
    textBody: parsedBody.textBody,
    htmlBody: parsedBody.htmlBody,
    rawEmail,
    receivedAt: new Date().toISOString()
  };
}

export function isLocalDomain(email) {
  return String(email || "").toLowerCase().endsWith(`@${config.emailDomain.toLowerCase()}`);
}
