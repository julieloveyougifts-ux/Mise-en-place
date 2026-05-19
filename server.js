import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import multer from 'multer';
import { mkdtemp, unlink, readdir, rmdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFile, writeFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Mise en place video backend' }));


async function uploadAndExtract(buffer, mimetype, displayName, captionText = '') {
  const size = buffer.length;
  const initRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': size,
      'X-Goog-Upload-Header-Content-Type': mimetype,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!initRes.ok) throw new Error(`File API init failed: ${await initRes.text()}`);
  const uploadUrl = initRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('No upload URL returned by Google.');
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Length': size, 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize', 'Content-Type': mimetype },
    body: buffer,
  });
  if (!uploadRes.ok) throw new Error(`File upload failed: ${await uploadRes.text()}`);
  const fileData = await uploadRes.json();
  const fileUri = fileData?.file?.uri;
  const fileName = fileData?.file?.name;
  if (!fileUri) throw new Error('No file URI returned after upload.');
  console.log(`Uploaded: ${fileUri}`);
  let state = fileData?.file?.state;
  let attempts = 0;
  while (state === 'PROCESSING' && attempts < 30) {
    await new Promise(r => setTimeout(r, 4000));
    const s = await (await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${GEMINI_API_KEY}`)).json();
    state = s?.state;
    console.log(`Polling: ${state} (${++attempts})`);
  }
  if (state !== 'ACTIVE') throw new Error(`File not ready: ${state}`);
  const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [
      { file_data: { mime_type: mimetype, file_uri: fileUri } },
      { text: 'Watch this cooking video and extract the recipe. Return ONLY JSON (no markdown) with: name, emoji, category (breakfast/lunch/dinner/dessert/snack), time (number minutes), servings (number), ingredients (string[]), steps (string[]). If not a recipe return {"error":"not a recipe"}.' + (captionText ? ` The video creator also provided this recipe description: ${captionText}. Use this along with what you see in the video to extract the complete recipe.` : '') }
    ]}]})
  });
  const gd = await geminiRes.json();
  const raw = (gd.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '').replace(/```json|```/g, '').trim();
  fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${GEMINI_API_KEY}`, { method: 'DELETE' }).catch(() => {});
  if (!raw) throw new Error('Gemini could not find a recipe in this video. Try a shorter clip showing the cooking and ingredients clearly.');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Gemini could not find a recipe in this video. Try a shorter clip showing the cooking and ingredients clearly.');
  }
}

app.post('/extract-video-file', upload.single('video'), async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set.' });
  if (!req.file) return res.status(400).json({ error: 'No video file provided.' });
  const captionText = req.body.captionText || '';
  console.log(`Extracting recipe from uploaded file: ${req.file.originalname} (${req.file.size} bytes)`);
  try {
    const recipe = await uploadAndExtract(req.file.buffer, req.file.mimetype, req.file.originalname, captionText);
    return res.json(recipe);
  } catch (err) {
    console.error('Extract error:', err.message);
    return res.status(500).json({ error: err.message || 'Could not extract recipe from that video.' });
  }
});

async function extractFromCaptionOnly(captionText, res) {
  const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: `Extract the recipe from this social media post caption. Return ONLY JSON (no markdown) with: name, emoji, category (breakfast/lunch/dinner/dessert/snack), time (number minutes), servings (number), ingredients (string[]), steps (string[]). If no recipe found return {"error":"not a recipe"}.\n\nCaption:\n${captionText}` }] }] })
  });
  const gd = await geminiRes.json();
  const raw = (gd.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '').replace(/```json|```/g, '').trim();
  if (!raw) return res.status(422).json({ error: 'No recipe found in that caption.' });
  try { return res.json(JSON.parse(raw)); }
  catch { return res.status(422).json({ error: 'No recipe found in that caption.' }); }
}

const MIME_MAP = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', m4v: 'video/mp4', avi: 'video/x-msvideo' };

async function downloadVideoToBuffer(url) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'mise-'));
  const outTemplate = join(tmpDir, 'video.%(ext)s');
  try {
    const { stderr } = await execFileAsync('yt-dlp', [
      '--no-playlist',
      '--max-filesize', '150m',
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '-o', outTemplate,
      url,
    ], { timeout: 120000 });
    if (stderr) console.log('yt-dlp stderr:', stderr);
    const files = await readdir(tmpDir);
    const videoFile = files.find(f => f.startsWith('video.'));
    if (!videoFile) throw new Error('Download failed — the video may be private or region-restricted.');
    const ext = videoFile.split('.').pop().toLowerCase();
    const buffer = await readFile(join(tmpDir, videoFile));
    const mimeType = MIME_MAP[ext] || 'video/mp4';
    console.log(`Downloaded ${videoFile} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
    return { buffer, mimeType, filename: videoFile };
  } finally {
    const files = await readdir(tmpDir).catch(() => []);
    for (const f of files) await unlink(join(tmpDir, f)).catch(() => {});
    await rmdir(tmpDir).catch(() => {});
  }
}

app.post('/extract-video-url', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set.' });
  let { url = '', captionText = '' } = req.body;
  url = url.trim();

  // Caption-only path — no URL needed
  if (!url && captionText) {
    console.log('No URL — extracting from caption text only');
    return extractFromCaptionOnly(captionText, res);
  }

  if (!url) return res.status(400).json({ error: 'No URL or caption provided.' });

  // Strip Facebook/Instagram tracking params
  try {
    const u = new URL(url);
    ['ref', 'mibextid', 'extid', '__tn__', 'sfnsn'].forEach(k => u.searchParams.delete(k));
    url = u.toString();
  } catch {}

  const isMeta = /facebook\.com|fb\.watch|instagram\.com/i.test(url);
  console.log(`Downloading video from URL: ${url}`);

  try {
    const { buffer, mimeType, filename } = await downloadVideoToBuffer(url);
    const recipe = await uploadAndExtract(buffer, mimeType, filename, captionText);
    return res.json(recipe);
  } catch (err) {
    console.error('URL extract error:', err.message);
    // If video download failed but we have caption text, fall back to text-only extraction
    if (captionText) {
      console.log('Video download failed — falling back to caption-only extraction');
      return extractFromCaptionOnly(captionText, res);
    }
    const friendly = isMeta
      ? 'Facebook and Instagram block video downloads from outside their apps. Paste the post caption/description in the field below instead — the AI can extract the recipe from the text alone.'
      : err.message.includes('private') || err.message.includes('region')
        ? err.message
        : 'Could not download that video. Make sure it is a public post and try again.';
    return res.status(500).json({ error: friendly });
  }
});

app.post('/ai/scan-photo', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set.' });
  const { image, mimeType } = req.body;
  if (!image) return res.status(400).json({ error: 'No image provided.' });
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: mimeType||'image/jpeg', data: image } }, { text: 'Extract recipe from this image. Return ONLY JSON (no markdown): name, emoji, category (breakfast/lunch/dinner/dessert/snack), time (number), servings (number), ingredients (string[]), steps (string[]). If no recipe: {"error":"not a recipe"}.' }] }] })
    });
    const d = await r.json();
    const txt = d.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'';
    return res.json(JSON.parse(txt.replace(/```json|```/g,'').trim()));
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

function extractJsonLdRecipe(html) {
  const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    try {
      const data = JSON.parse(block.replace(/<script[^>]*>/i,'').replace(/<\/script>/i,'').trim());
      const schemas = Array.isArray(data) ? data : data['@graph'] ? data['@graph'] : [data];
      for (const s of schemas) {
        const type = s['@type'];
        if (type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))) return s;
      }
    } catch {}
  }
  return null;
}

function schemaToRecipe(s) {
  const timeStr = s.totalTime || s.cookTime || s.prepTime || '';
  const tm = timeStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  const time = (parseInt(tm?.[1]||0)*60 + parseInt(tm?.[2]||0)) || 30;
  const servings = parseInt(Array.isArray(s.recipeYield) ? s.recipeYield[0] : s.recipeYield) || 4;
  const ingredients = (s.recipeIngredient||[]).map(i=>i.replace(/&#\d+;/g,c=>String.fromCharCode(parseInt(c.slice(2)))).replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim());
  const steps = (s.recipeInstructions||[]).map(i=>typeof i==='string'?i:(i.text||i.name||'')).filter(Boolean);
  const cat = (Array.isArray(s.recipeCategory)?s.recipeCategory[0]:s.recipeCategory||'').toLowerCase();
  const category = ['breakfast','lunch','dinner','dessert','snack'].find(c=>cat.includes(c))||'dinner';
  return { name: s.name||'Recipe', emoji:'🍽️', category, time, servings, ingredients, steps };
}

app.post('/ai/extract-url', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set.' });
  let { url, pageText } = req.body;

  let html = '';
  if (url && !pageText) {
    try {
      const u = new URL(url);
      ['fbclid','utm_source','utm_medium','utm_campaign','utm_content','utm_term'].forEach(k => u.searchParams.delete(k));
      url = u.toString();
      const pageRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow' });
      if (!pageRes.ok) return res.status(422).json({ error: `Could not fetch that page (${pageRes.status}). Check the URL and try again.` });
      html = await pageRes.text();
    } catch(e) {
      return res.status(422).json({ error: 'Could not reach that URL. Check the link and try again.' });
    }
  }

  // Try JSON-LD structured data first — most recipe sites include this and it's exact
  if (html) {
    const schema = extractJsonLdRecipe(html);
    if (schema) {
      console.log(`JSON-LD recipe found: ${schema.name}`);
      return res.json(schemaToRecipe(schema));
    }
    // Fall back to plain text for Gemini
    pageText = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<script[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s{2,}/g,' ').trim().slice(0, 14000);
  }

  if (!pageText) return res.status(400).json({ error: 'No URL or page text provided.' });
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: `Extract recipe from this webpage. Return ONLY JSON (no markdown): name, emoji, category (breakfast/lunch/dinner/dessert/snack), time (number), servings (number), ingredients (string[]), steps (string[]). If no recipe: {"error":"not a recipe"}.\n\n${pageText}` }] }] })
    });
    const d = await r.json();
    const txt = (d.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'').replace(/```json|```/g,'').trim();
    if (!txt) return res.status(422).json({ error: 'No recipe found at that URL.' });
    return res.json(JSON.parse(txt));
  } catch(e) { return res.status(500).json({ error: 'Could not extract a recipe from that page.' }); }
});

app.post('/ai/scan-fridge', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set.' });
  const { image, mimeType, image2, mimeType2, savedRecipes } = req.body;
  if (!image) return res.status(400).json({ error: 'No image.' });
  try {
    const parts = [{ inline_data: { mime_type: mimeType||'image/jpeg', data: image } }];
    if (image2) parts.push({ inline_data: { mime_type: mimeType2||'image/jpeg', data: image2 } });
    const photoDesc = image2 ? 'these fridge and pantry photos' : 'this fridge/pantry photo';
    parts.push({ text: `Suggest 4 recipes from ${photoDesc}. Saved recipes: ${savedRecipes||'none'}. Return ONLY a JSON array: [{name, emoji, description (1 sentence), ingredients_needed (string[])}]. No markdown.` });
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] })
    });
    const d = await r.json();
    const txt = d.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'[]';
    return res.json(JSON.parse(txt.replace(/```json|```/g,'').trim()));
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

app.post('/ai/grocery-list', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set.' });
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'No prompt.' });
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const d = await r.json();
    const txt = d.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'[]';
    return res.json(JSON.parse(txt.replace(/```json|```/g,'').trim()));
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

app.post('/ai/ask', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set.' });
  const { question, recipeNames } = req.body;
  if (!question) return res.status(400).json({ error: 'No question.' });
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_instruction: { parts: [{ text: `Helpful cooking assistant. User's recipes: ${recipeNames||'none'}. Reply under 80 words, no markdown.` }] }, contents: [{ parts: [{ text: question }] }] })
    });
    const d = await r.json();
    const answer = d.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'Sorry, could not respond.';
    return res.json({ answer });
  } catch(e) { return res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Mise en place backend running on port ${PORT}`));

app.post('/debug-ytdlp', async (req, res) => {
  const { url } = req.body;
  try {
    const result = await downloadVideoToBuffer(url);
    return res.json({ ok: true, size: result.buffer.length, mime: result.mimeType });
  } catch(e) {
    return res.json({ error: e.message, stderr: e.stderr || '', stdout: e.stdout || '' });
  }
});
