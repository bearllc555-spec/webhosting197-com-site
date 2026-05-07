/**
 * POST /api/edit  (production)
 *
 * Customer types "make the hero green" → this endpoint translates the request
 * into a validated JSON diff against their current site.json and returns the
 * proposed change for preview. The customer-facing chat UI calls this and
 * renders the diff for the customer to approve before /api/apply persists it.
 *
 * Key implementation note: API key is sent via the x-goog-api-key header,
 * NOT in the URL query string. Putting the key in the URL caused error
 * messages (with that URL embedded) to trip Cloudflare's secret-leak
 * protection, returning generic 502 HTML instead of our JSON errors.
 */

const SYSTEM_PROMPT =
  "You are Press, the editor for a small-business website builder. The customer " +
  "is a tradesperson, shop owner, or service provider - not a designer, not a " +
  "developer. They describe what they want in plain English. Your job: turn that " +
  "into a JSON diff against their site.json and explain what you did in one short, " +
  "friendly sentence.\n\n" +

  "## Schema (what you can change)\n\n" +
  "Top-level keys: meta, business, brand, services (array), sections (array), pages.\n" +
  "Sections each have a `type` and `props`. Section types and their key props:\n" +
  "  - hero: headline, subheadline, cta_label, cta_href, background_image_url\n" +
  "  - services_grid: heading, layout, service_indices\n" +
  "  - gallery: heading, image_urls, layout\n" +
  "  - testimonials: heading, testimonials[{quote, author, role, avatar_url}]\n" +
  "  - cta: heading, subheading, cta_label, cta_href\n" +
  "  - form: heading, fields, submit_label, destination_email\n" +
  "  - town_intros: heading, videos\n" +
  "Brand colors live at brand.colors.{primary, accent, neutral_dark, neutral_light}. " +
  "Services live at services[N].\n\n" +

  "## How to return your answer\n\n" +
  "Return ONLY a JSON object, no prose, no code fences, matching:\n" +
  '{"narration": "<plain English, <=2 sentences, friendly, see voice rules below>", ' +
  '"diff": [{"op": "set|remove|insert|move", "path": "<dot.path>", "value": <any>, "index": <number?>, "from": "<path?>", "to": "<path?>"}], ' +
  '"confidence": 0.0 to 1.0, "warnings": []}\n\n' +
  'Path syntax is dot-separated, array indices as [N]. Examples: "brand.colors.primary", "sections[2].props.headline", "services[0].name", "sections[1].props.testimonials[0].quote".\n\n' +

  "## Color rules (very important - customers describe colors loosely, you map carefully)\n\n" +
  "Always pick a hex that, when shown on a white-ish or off-white page, clearly READS as the color the customer named. Never go so dark it reads as black or charcoal.\n" +
  "Default mapping when the customer is not specific:\n" +
  "  - blue -> #2563EB (clear, friendly blue)\n" +
  "  - dark blue -> #1D4ED8 (still unmistakably blue, deeper than default)\n" +
  "  - navy -> #1E3A8A (only when the customer literally says navy, midnight, or deep sea)\n" +
  "  - green -> #15803D (forester green)\n" +
  "  - dark green -> #166534\n" +
  "  - red -> #DC2626\n" +
  "  - dark red / wine -> #991B1B\n" +
  "  - terracotta / rust -> #C2410C\n" +
  "  - rose / pink -> #BE123C\n" +
  "  - purple -> #7C3AED\n" +
  "  - slate / gray -> #475569\n" +
  "  - black -> #111827 (never #000000; always include a touch of warmth)\n" +
  "  - white -> #FFFFFF\n" +
  "If the customer says 'darker' for an existing color, shift one step on the same hue family - never to black. If they say 'brighter' or 'lighter', shift up the same way.\n\n" +

  "## Customer vocabulary -> schema mapping (they don't know our names)\n\n" +
  "Translate what they say to where you write. They will NEVER use words like 'hero', 'CTA', 'services_grid', 'props'. Map their words to schema paths:\n" +
  "  - 'top part', 'big headline area', 'banner', 'first thing', 'header on the page' -> the hero section\n" +
  "  - 'main headline', 'big text up top', 'title' -> sections[heroIndex].props.headline\n" +
  "  - 'subheadline', 'tagline', 'line under the title', 'description below' -> sections[heroIndex].props.subheadline\n" +
  "  - 'button at the top', 'main button', 'big call button' -> sections[heroIndex].props.cta_label / cta_href\n" +
  "  - 'what we do', 'services', 'services part', 'list of jobs we do' -> services_grid section / services[] array\n" +
  "  - 'testimonials', 'reviews', 'what people say', 'customer quotes' -> testimonials section\n" +
  "  - 'contact form', 'sign-up form', 'request form' -> form section\n" +
  "  - 'photo strip', 'pictures', 'gallery' -> gallery section\n" +
  "  - 'call-out', 'big banner near the bottom', 'final pitch', 'last button' -> cta section\n" +
  "  - 'main color', 'brand color', 'theme color' -> brand.colors.primary\n" +
  "  - 'accent', 'highlight color' -> brand.colors.accent\n\n" +

  "## Narration voice rules\n\n" +
  "When you write the `narration`, output PLAIN ENGLISH the customer will recognize. Mirror their words back to them.\n" +
  "  - Say 'the big headline at the top', NOT 'the hero headline'\n" +
  "  - Say 'the main button', NOT 'the CTA'\n" +
  "  - Say 'your services list', NOT 'the services_grid'\n" +
  "  - Say 'your main brand color', NOT 'brand.colors.primary'\n" +
  "Keep it humble and brief. Examples of GOOD narration:\n" +
  "  - 'Switching your main brand color to a darker blue. Say if you want a different shade.'\n" +
  "  - 'Made the headline bigger and bolder. Tell me if it should be different.'\n" +
  "  - 'Changed all your buttons to purple - heads-up, that affects every button on the site, not just the one you clicked.'\n" +
  "Examples of BAD narration (do NOT write like this):\n" +
  "  - 'I have chosen a tasteful forest green as a sophisticated alternative; please confirm.' <- pretentious, condescending\n" +
  "  - 'Updated brand.colors.primary to #15803D affecting the hero CTA.' <- jargon\n" +
  "  - 'I cannot do that because the schema does not allow direct color changes to individual buttons.' <- never refuse this way\n\n" +

  "## Scope discipline (important - do not over-deliver)\n\n" +
  "Do exactly what was asked. Do NOT also 'improve' wording, 'tighten' copy, change other colors, or restyle adjacent sections. If they asked for a button color, change the button color. Period. The customer will ask for more changes when they want them.\n" +
  "If a targeting hint says they clicked a specific section or sub-element, scope your diff to that target unless they explicitly say 'site-wide' or 'everywhere' or 'all of them'.\n\n" +

  "## Smart scoping for shared/global elements\n\n" +
  "Some things the customer might point at are shared globally (e.g., button styles all share brand.colors.primary; the header/footer copy is in business.name and pages config). NEVER refuse with 'the schema does not allow that'. The schema lets you change anything visual. Instead:\n" +
  "  1. Find the closest schema field that achieves their visible intent.\n" +
  "  2. Make the change.\n" +
  "  3. In the narration, briefly tell them about any side effect ('heads-up, this also changes your other buttons since they share the same color').\n" +
  "Example - they click one button and say 'make this purple': set brand.colors.primary to a purple hex, AND in narration say 'changed your button color to purple - that applies to every button since they share the same color.' Do not refuse and do not lecture them about design systems.\n" +
  "If the customer is making what looks like a bad design choice, that is THEIR call. Make the change. Do not editorialize.\n\n" +

  "## Confidence and warnings\n\n" +
  "  - confidence >= 0.85 when the request is clear and you mapped it cleanly\n" +
  "  - confidence 0.6-0.85 when you had to guess at one detail (e.g., exact shade of a color)\n" +
  "  - confidence < 0.6 when the request is ambiguous; add a warning explaining what you assumed\n" +
  "If the request is genuinely impossible within the schema (e.g., 'add a video chat widget'), return diff=[] and explain in narration what you can do instead. Do not return a diff that does nothing.";

export async function onRequestPost(context) {
  try {
    return await handle(context);
  } catch (err) {
    return jsonResp(500, {
      error: "uncaught",
      message: err && err.message ? err.message : String(err),
    });
  }
}

async function handle({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResp(400, { error: "invalid JSON body" });
  }
  if (!body || !body.siteJson || typeof body.siteJson !== "object") {
    return jsonResp(400, { error: "missing or invalid siteJson" });
  }
  if (typeof body.request !== "string" || body.request.trim().length === 0) {
    return jsonResp(400, { error: "missing or empty request" });
  }
  if (body.request.length > 2000) {
    return jsonResp(400, { error: "request too long (max 2000 chars)" });
  }
  if (!env.GEMINI_API_KEY) {
    return jsonResp(500, { error: "GEMINI_API_KEY not configured" });
  }

  // If the customer pointed at a specific section (and optionally a
  // sub-element within it), surface that targeting hint to the model so it
  // scopes the diff narrowly.
  let targetingHint = "";
  if (
    typeof body.targetType === "string" &&
    typeof body.targetIndex === "number" &&
    body.targetType.length > 0
  ) {
    const safeLabel =
      typeof body.targetLabel === "string" && body.targetLabel.length < 120
        ? body.targetLabel
        : body.targetType;

    // Build the parent-section hint
    let hint =
      "\n\nIMPORTANT TARGETING HINT: The customer clicked on a specific section " +
      "in the preview before sending this request. They are pointing at: " +
      JSON.stringify(safeLabel) +
      " — corresponds to sections[" + body.targetIndex + "] of type " +
      JSON.stringify(body.targetType) + ".";

    // If they ALSO clicked a sub-element within that section, add that detail
    if (
      typeof body.subTargetKind === "string" &&
      typeof body.subTargetIndex === "number" &&
      body.subTargetKind.length > 0
    ) {
      const safeSubLabel =
        typeof body.subTargetLabel === "string" && body.subTargetLabel.length < 200
          ? body.subTargetLabel
          : body.subTargetKind;
      hint +=
        " WITHIN that section, they pointed at a specific sub-element: " +
        JSON.stringify(safeSubLabel) +
        " — sub-element kind " + JSON.stringify(body.subTargetKind) +
        ", sub-index " + body.subTargetIndex + ".";

      // Path hints per sub-kind so the model knows where to write
      if (body.subTargetKind === "service_card") {
        hint += " The path for this sub-element is services[" + body.subTargetIndex + "].";
      } else if (body.subTargetKind === "testimonial_card") {
        hint += " The path for this sub-element is sections[" + body.targetIndex +
          "].props.testimonials[" + body.subTargetIndex + "].";
      } else if (body.subTargetKind === "headline") {
        hint += " The path for this sub-element is sections[" + body.targetIndex + "].props.headline.";
      } else if (body.subTargetKind === "subheadline") {
        hint += " The path for this sub-element is sections[" + body.targetIndex + "].props.subheadline.";
      } else if (body.subTargetKind === "heading") {
        hint += " The path for this sub-element is sections[" + body.targetIndex + "].props.heading.";
      } else if (body.subTargetKind === "cta_button") {
        hint += " The button text is at sections[" + body.targetIndex +
          "].props.cta_label and the link target is at sections[" + body.targetIndex + "].props.cta_href.";
      }

      hint +=
        " Scope your diff to ONLY this sub-element unless the customer explicitly asks for a broader change. " +
        "Do not modify other parts of the section, other sections, or global brand colors.";
    } else {
      hint +=
        " Scope your diff to that section only — do not change unrelated sections, " +
        "global brand colors, or the whole site, unless the customer explicitly says so. " +
        "If their request makes more sense applied site-wide (e.g., changing brand color), " +
        "still acknowledge the targeted section in your narration.";
    }

    targetingHint = hint;
  }

  const userPrompt =
    "Current site.json:\n```json\n" +
    JSON.stringify(body.siteJson, null, 2) +
    "\n```\n\nCustomer's request: " +
    body.request.trim() +
    targetingHint +
    "\n\nRespond with the JSON object only.";

  let geminiText;
  try {
    geminiText = await callGemini(env.GEMINI_API_KEY, SYSTEM_PROMPT, userPrompt);
  } catch (err) {
    return jsonResp(502, {
      error: "gemini call failed",
      message: err && err.message ? err.message : String(err),
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(geminiText);
  } catch {
    return jsonResp(502, {
      error: "model output not JSON",
      modelText: geminiText.slice(0, 400),
    });
  }

  if (
    typeof parsed.narration !== "string" ||
    !Array.isArray(parsed.diff) ||
    typeof parsed.confidence !== "number"
  ) {
    return jsonResp(502, {
      error: "model output malformed",
      received: parsed,
    });
  }
  parsed.warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];

  let proposedSite = body.siteJson;
  let validated = true;
  let validationError = null;
  try {
    proposedSite = applyDiff(body.siteJson, parsed.diff);
  } catch (err) {
    validated = false;
    validationError = err && err.message ? err.message : String(err);
  }

  return jsonResp(200, {
    narration: parsed.narration,
    diff: parsed.diff,
    confidence: parsed.confidence,
    warnings: parsed.warnings,
    proposedSite,
    validated,
    validationError,
    provider: "gemini",
  });
}

export async function onRequestGet({ env }) {
  return jsonResp(200, {
    handler: "GET",
    hasGeminiKey: !!env.GEMINI_API_KEY,
    modelProvider: env.MODEL_PROVIDER || "gemini",
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, GET, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    },
  });
}

/* ---------- Gemini call (header auth) ---------- */

async function callGemini(apiKey, systemPrompt, userPrompt) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
    },
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  const text = await r.text();
  if (!r.ok) {
    throw new Error("gemini http " + r.status + ": " + text.slice(0, 300));
  }

  let topLevel;
  try {
    topLevel = JSON.parse(text);
  } catch {
    throw new Error("gemini returned non-JSON");
  }

  const out =
    topLevel?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!out) {
    throw new Error("gemini returned no text");
  }
  return out;
}

/* ---------- diff applier ---------- */

function applyDiff(input, diff) {
  const out = JSON.parse(JSON.stringify(input));
  for (const op of diff) applyOp(out, op);
  return out;
}

function applyOp(root, op) {
  if (op.op === "set") return setAtPath(root, op.path, op.value);
  if (op.op === "remove") return removeAtPath(root, op.path);
  if (op.op === "insert") return insertAtPath(root, op.path, op.value, op.index);
  if (op.op === "move") {
    const tokens = tokenize(op.from);
    const parent = walkToParent(root, tokens);
    const last = tokens[tokens.length - 1];
    let value;
    if (last.kind === "key") {
      value = parent[last.value];
      delete parent[last.value];
    } else {
      if (!Array.isArray(parent)) throw new Error("move from non-array");
      value = parent[last.value];
      parent.splice(last.value, 1);
    }
    return setAtPath(root, op.to, value);
  }
  throw new Error("unknown op: " + op.op);
}

function tokenize(path) {
  const tokens = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) tokens.push({ kind: "key", value: m[1] });
    else if (m[2] !== undefined) tokens.push({ kind: "index", value: parseInt(m[2], 10) });
  }
  return tokens;
}

function walkTo(root, tokens) {
  let cur = root;
  for (const t of tokens) {
    if (t.kind === "key") {
      if (cur === null || typeof cur !== "object") throw new Error("walk into non-object");
      cur = cur[t.value];
    } else {
      if (!Array.isArray(cur)) throw new Error("index access on non-array");
      cur = cur[t.value];
    }
  }
  return cur;
}

function walkToParent(root, tokens) {
  return walkTo(root, tokens.slice(0, -1));
}

function setAtPath(root, path, value) {
  const tokens = tokenize(path);
  if (tokens.length === 0) throw new Error("empty path");
  const last = tokens[tokens.length - 1];
  const parent = walkToParent(root, tokens);
  if (last.kind === "key") parent[last.value] = value;
  else parent[last.value] = value;
}

function removeAtPath(root, path) {
  const tokens = tokenize(path);
  if (tokens.length === 0) throw new Error("empty path");
  const last = tokens[tokens.length - 1];
  const parent = walkToParent(root, tokens);
  if (last.kind === "key") delete parent[last.value];
  else parent.splice(last.value, 1);
}

function insertAtPath(root, path, value, index) {
  const tokens = tokenize(path);
  const target = walkTo(root, tokens);
  if (!Array.isArray(target)) throw new Error("insert into non-array");
  if (index === undefined) target.push(value);
  else target.splice(Math.max(0, Math.min(index, target.length)), 0, value);
}

/* ---------- helpers ---------- */

function jsonResp(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}
