#!/usr/bin/env node

import fs from "fs";
import got from "got";
import path from "path";
import { pipeline as streamPipeline } from 'node:stream/promises';

let args = { url: null, dst: null };

function parseArgs() {
  for (let arg of process.argv) {
    Object.keys(args).forEach((key) => {
      if (arg.trim().startsWith(key + ":")) {
        args[key] = arg.substring(key.length + 1);
      }
    });
  }
}

function isAllArgsPresent() {
  return Object.values(args).filter((v) => v == null).length == 0;
}

// --- Persistent state ---
function stateFile(dst) {
  return path.join(dst, ".dump-state.json");
}

function loadState(dst) {
  const f = stateFile(dst);
  if (fs.existsSync(f)) {
    try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { }
  }
  return { tree: null, downloaded: {} };
}

function saveState(dst, state) {
  fs.writeFileSync(stateFile(dst), JSON.stringify(state, null, 2));
}

// --- Concurrency limiter ---
function limit(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve).catch(reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}

const discoverLimit = limit(3);
const downloadLimit = limit(3);

// --- Discovery ---
async function extractHref(pageHtml) {
  let regexFiles = /href="([\w\-\.]+)"/gm;
  let regexFolders = /href="([\w\-\.]+\/)"/gm;
  let files = pageHtml.match(regexFiles) ?? [];
  let folders = pageHtml.match(regexFolders) ?? [];
  files = files.map((f) => f.substring(6, f.length - 1));
  folders = folders.map((f) => f.substring(6, f.length - 1));
  console.log(`-> found ${files.length} files and ${folders.length} folders.`);
  return { files, folders };
}

async function discoverTree(url, currentFolder = "", tree = {}) {
  console.log(`👀 ${url}...`);
  let pageHtml;
  try {
    pageHtml = await discoverLimit(() =>
      got(url, {
        retry: { limit: 3 },
        timeout: { request: 30000 },
      }).text()
    );
  } catch (err) {
    console.warn(`⚠ Skipping ${url} — ${err.code ?? err.message}`);
    tree[currentFolder] = { files: [] };
    return tree;
  }

  let href = await extractHref(pageHtml);
  tree[currentFolder] = { files: href.files };

  await Promise.all(
    href.folders.map((folder) =>
      discoverTree(url + folder, currentFolder + folder, tree).catch((err) => {
        console.warn(`⚠ Failed subtree ${folder}: ${err.message}`);
        tree[currentFolder + folder] = { files: [] };
      })
    )
  );

  return tree;
}

// --- Download with retry ---
async function downloadFile(url, destFile, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const tmp = destFile + ".tmp";
      const stream = got.stream(url, {
        timeout: {
          connect: 10000,   // 10s to establish TCP connection
          socket: 60000,    // 60s max inactivity between received bytes
        }
      });
      await streamPipeline(stream, fs.createWriteStream(tmp));
      fs.renameSync(tmp, destFile);
      return true;
    } catch (err) {
      const willRetry = attempt < retries;
      console.warn(`⚠ [${attempt}/${retries}] Failed: ${url} — ${err.code ?? err.message}${willRetry ? ", retrying..." : ", giving up."}`);
      if (!willRetry) return false;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function downloadTree(baseUrl, tree, dst, state, baseDst) {
  if (!fs.existsSync(dst)) fs.mkdirSync(dst);

  const jobs = Object.keys(tree).flatMap((key) =>
    tree[key].files.map((file) => ({ key, file }))
  );

  const total = jobs.length;
  let done = 0;
  console.log(`📦 ${total} files to process...`);

  if (total === 0) {
    console.error("❌ Tree is empty — no files discovered. Check the URL or the HTML parsing.");
    return;
  }

  await Promise.all(
    jobs.map(({ key, file }) =>
      downloadLimit(async () => {
        const fileKey = key + file;
        const destFolder = path.join(dst, key);
        const destFile = path.join(destFolder, file);

        if (state.downloaded[fileKey]) {
          console.info(`ℹ Skip (cached): ${fileKey}`);
          done++;
          return;
        }

        console.log(`⬇ Starting: ${fileKey}`);
        fs.mkdirSync(destFolder, { recursive: true });

        const success = await downloadFile(baseUrl + fileKey, destFile);
        if (success) {
          state.downloaded[fileKey] = true;
          saveState(baseDst, state);
        }

        done++;
        console.log(`[${done}/${total}] ${success ? "✅" : "❌"} ${fileKey}`);
      })
    )
  );
}

/* ---- MAIN ---- */
try {
  parseArgs();
  if (!isAllArgsPresent()) {
    console.log("Usage: node dump.js url:http://{website}/.git/ dst:folderName");
    process.exit(1);
  }

  fs.mkdirSync(args.dst, { recursive: true });
  const state = loadState(args.dst);

  if (state.tree) {
    console.log("📂 Reusing cached tree from previous run.");
  } else {
    console.log("🔍 Discovering tree...");
    state.tree = await discoverTree(args.url);
    const totalFolders = Object.keys(state.tree).length;
    const totalFiles = Object.values(state.tree).reduce((n, v) => n + v.files.length, 0);
    console.log(`💾 Tree saved — ${totalFolders} folders, ${totalFiles} files total.`);
    saveState(args.dst, state);
  }

  await downloadTree(args.url, state.tree, path.join(args.dst, ".git/"), state, args.dst);
  console.log("✅ Done.");
} catch (err) {
  console.error("ERROR:", err, err?.url);
}