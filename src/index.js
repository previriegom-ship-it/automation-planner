/**
 * Automation Planner — Cloudflare Worker (backend seguro)
 *
 * Recibe POST /generate con las 8 respuestas del usuario, llama a Anthropic
 * usando la API key de los Secrets de Cloudflare, y devuelve { success, plan, html }.
 * El frontend nunca ve la API key.
 */

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8000;
const API_URL = 'https://api.anthropic.com/v1/messages';

const PREGUNTAS = [
  '¿Qué negocio o área quieres automatizar y a qué se dedica?',
  '¿Qué proceso concreto te quita más tiempo hoy y cómo lo haces ahora?',
  '¿Qué herramientas o software usas actualmente en ese proceso?',
  '¿Cuántas personas intervienen y qué hace cada una?',
  '¿Con qué frecuencia ocurre este proceso (diario, semanal, por evento)?',
  '¿Cuál sería el resultado ideal si estuviera automatizado?',
  '¿Qué nivel técnico tiene el equipo (nada, básico, avanzado)?',
  '¿Tienes presupuesto o prefieres soluciones gratuitas/no-code?'
];

const JSON_SCHEMA = `{
  "metadata": { "title": "string", "createdAt": "ISO timestamp", "businessContext": "string", "version": "1.0" },
  "summary": { "objective": "string", "currentState": "string", "desiredState": "string" },
  "phases": [
    { "id": 1, "name": "string", "goal": "string", "estimatedDuration": "string",
      "tasks": [ { "id": "1.1", "description": "string", "tool": "string", "noCodeAlternative": "string", "estimatedEffort": "string", "dependencies": [] } ],
      "risks": ["string"] }
  ],
  "tools": [ { "name": "string", "purpose": "string", "cost": "string" } ],
  "executionChecklist": [ { "id": "string", "item": "string", "phase": 1, "done": false } ],
  "nextSteps": ["string"],
  "risksAndMitigations": [ { "risk": "string", "impact": "high|medium|low", "mitigation": "string" } ]
}`;

const SYSTEM_PROMPT = `Eres un planificador experto en automatización de procesos con IA y herramientas no-code. Recibes las respuestas de un cuestionario y produces un plan de implementación estructurado.

Responde ÚNICAMENTE con un objeto JSON válido. Sin texto antes ni después, sin bloques markdown, sin explicaciones.

El JSON debe seguir EXACTAMENTE este esquema:
${JSON_SCHEMA}

Reglas:
- Divide el plan en 4 a 6 fases lógicas y ordenadas.
- Cada tarea debe nombrar una herramienta concreta y, cuando exista, una alternativa no-code real.
- Ajusta las herramientas y el presupuesto al nivel técnico y a las preferencias indicadas.
- Si una respuesta es vaga, haz la mejor suposición razonable, pero no inventes datos críticos del negocio.
- En "createdAt" usa un timestamp ISO 8601.
- Escribe todo el contenido en español, sin guiones largos.`;

// ---------------------------------------------------------------------------
// Funciones auxiliares
// ---------------------------------------------------------------------------

function validarApiKey(apiKey) {
  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    throw new Error('API key no configurada');
  }
  return true;
}

async function generarPlan(respuestas, apiKey) {
  const contenidoUsuario = PREGUNTAS
    .map((pregunta, i) => {
      const valor = respuestas[i + 1] ?? respuestas[String(i + 1)] ?? '';
      return `${i + 1}. ${pregunta}\nRespuesta: ${valor}`;
    })
    .join('\n\n');

  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: contenidoUsuario }]
      })
    });
  } catch (err) {
    throw new Error('No se pudo conectar con la API de Anthropic. Intenta de nuevo en unos segundos.');
  }

  if (!response.ok) {
    if (response.status === 401) throw new Error('API key inválida');
    if (response.status === 429) throw new Error('Límite de uso alcanzado, intenta en unos segundos');
    let detalle = '';
    try {
      const errBody = await response.json();
      detalle = errBody?.error?.message || '';
    } catch {
      detalle = '';
    }
    throw new Error(`Error de la API (HTTP ${response.status})${detalle ? ': ' + detalle : ''}`);
  }

  const data = await response.json();
  const texto = data?.content?.[0]?.text;
  if (!texto || !texto.trim()) {
    throw new Error('La API devolvió una respuesta vacía');
  }
  return texto;
}

function extraerJSON(textoCrudo) {
  console.log('[Worker] texto crudo (primeros 500):', textoCrudo.substring(0, 500));

  // Limpieza por capas: fences de markdown, caracteres sueltos, BOM
  let limpio = textoCrudo
    .trim()
    .replace(/^﻿/, '')                     // BOM
    .replace(/^```(?:json)?\s*\n?/i, '')        // ``` o ```json al inicio
    .replace(/\n?```\s*$/i, '')                 // ``` al final
    .trim();

  // Extrae el objeto JSON aunque haya texto antes/después
  const inicio = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}');
  if (inicio === -1 || fin === -1 || fin <= inicio) {
    console.error('[Worker] no se encontró objeto JSON. Texto limpio:', limpio.substring(0, 300));
    throw new Error(`La respuesta de Claude no contiene un objeto JSON válido. Inicio del texto: ${textoCrudo.substring(0, 200)}`);
  }
  if (inicio > 0 || fin < limpio.length - 1) {
    limpio = limpio.slice(inicio, fin + 1);
  }

  console.log('[Worker] JSON extraído (primeros 500):', limpio.substring(0, 500));

  let plan;
  try {
    plan = JSON.parse(limpio);
  } catch (err) {
    console.error('[Worker] JSON.parse falló:', err.message);
    console.error('[Worker] texto completo enviado a parse:', limpio);
    throw new Error(`JSON inválido (${err.message}). Texto crudo (primeros 300): ${textoCrudo.substring(0, 300)}`);
  }

  // Validación de campos obligatorios
  const faltantes = [];
  if (!plan.metadata || typeof plan.metadata !== 'object') faltantes.push('metadata');
  if (!Array.isArray(plan.phases) || plan.phases.length === 0) faltantes.push('phases (array no vacío)');
  if (!Array.isArray(plan.executionChecklist)) faltantes.push('executionChecklist');

  if (faltantes.length > 0) {
    console.error('[Worker] campos faltantes:', faltantes);
    throw new Error(`Plan generado incompleto (faltan: ${faltantes.join(', ')})`);
  }

  console.log('[Worker] plan válido — fases:', plan.phases.length, '| checklist items:', plan.executionChecklist.length);
  return plan;
}

function esc(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generarHTML(plan) {
  const m = plan.metadata || {};
  const s = plan.summary || {};
  const phases = plan.phases || [];
  const tools = plan.tools || [];
  const checklist = plan.executionChecklist || [];
  const nextSteps = plan.nextSteps || [];
  const risks = plan.risksAndMitigations || [];

  const fechaLegible = m.createdAt ? new Date(m.createdAt).toLocaleString('es-ES') : '';

  const phasesHTML = phases.map((p) => {
    const tasks = (p.tasks || []).map((t) => `
      <li class="task">
        <div class="task-desc"><span class="task-id">${esc(t.id)}</span> ${esc(t.description)}</div>
        <div class="task-meta">
          <span><strong>Herramienta:</strong> ${esc(t.tool)}</span>
          ${t.noCodeAlternative ? `<span><strong>Alternativa no-code:</strong> ${esc(t.noCodeAlternative)}</span>` : ''}
          ${t.estimatedEffort ? `<span><strong>Esfuerzo:</strong> ${esc(t.estimatedEffort)}</span>` : ''}
        </div>
      </li>`).join('');

    const phaseRisks = (p.risks || []).length
      ? `<div class="phase-risks"><strong>Riesgos de la fase:</strong><ul>${(p.risks || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>`
      : '';

    return `
    <details class="phase">
      <summary><span class="phase-name">Fase ${esc(p.id)}: ${esc(p.name)}</span><span class="phase-dur">${esc(p.estimatedDuration)}</span></summary>
      <div class="phase-body">
        ${p.goal ? `<p class="phase-goal"><strong>Objetivo:</strong> ${esc(p.goal)}</p>` : ''}
        <ul class="tasks">${tasks}</ul>
        ${phaseRisks}
      </div>
    </details>`;
  }).join('');

  const toolsHTML = tools.map((t) => `
    <tr><td><strong>${esc(t.name)}</strong></td><td>${esc(t.purpose)}</td><td>${esc(t.cost)}</td></tr>`).join('');

  const checklistHTML = checklist.map((c) => `
    <label class="check-item">
      <input type="checkbox" data-check-id="${esc(c.id)}">
      <span>${esc(c.item)} <em class="phase-tag">Fase ${esc(c.phase)}</em></span>
    </label>`).join('');

  const nextStepsHTML = nextSteps.map((n) => `<li>${esc(n)}</li>`).join('');

  const risksHTML = risks.map((r) => `
    <tr>
      <td>${esc(r.risk)}</td>
      <td><span class="impact impact-${esc((r.impact || '').toLowerCase())}">${esc(r.impact)}</span></td>
      <td>${esc(r.mitigation)}</td>
    </tr>`).join('');

  const storageKey = `automation-plan-${esc(m.createdAt || m.title || 'plan')}`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(m.title || 'Plan de Automatización')}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f6fb;color:#1f2333;line-height:1.6}
  .wrap{max-width:880px;margin:0 auto;padding:2.5rem 1.5rem}
  header{background:#1b2a4a;color:#fff;border-radius:12px;padding:2rem;margin-bottom:1.5rem}
  header h1{font-size:1.7rem;margin-bottom:.4rem}
  header .meta{font-size:.9rem;opacity:.85}
  header .ctx{margin-top:.8rem;font-size:.95rem}
  section{background:#fff;border-radius:12px;padding:1.5rem;margin-bottom:1.25rem;box-shadow:0 1px 4px rgba(0,0,0,.06)}
  h2{font-size:1.2rem;color:#1b2a4a;margin-bottom:1rem;border-bottom:2px solid #e94560;padding-bottom:.35rem}
  .summary-grid{display:grid;gap:.9rem}
  .summary-grid div{padding:.8rem 1rem;background:#f4f6fb;border-radius:8px}
  .summary-grid strong{color:#0f3460;display:block;margin-bottom:.2rem}
  details.phase{border:1px solid #e3e7f0;border-radius:10px;margin-bottom:.8rem;overflow:hidden}
  details.phase summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:1rem 1.2rem;background:#1b2a4a;color:#fff;font-weight:600}
  details.phase summary::-webkit-details-marker{display:none}
  .phase-dur{background:#e94560;padding:.2rem .65rem;border-radius:12px;font-size:.78rem;white-space:nowrap}
  .phase-body{padding:1.2rem}
  .phase-goal{margin-bottom:.9rem;color:#444}
  ul.tasks{list-style:none}
  li.task{border-left:3px solid #e94560;padding:.6rem .9rem;margin-bottom:.7rem;background:#f9fafd;border-radius:0 8px 8px 0}
  .task-id{display:inline-block;background:#1b2a4a;color:#fff;border-radius:5px;padding:0 .4rem;font-size:.75rem;margin-right:.3rem}
  .task-meta{display:flex;flex-wrap:wrap;gap:.4rem 1.2rem;font-size:.85rem;color:#555;margin-top:.35rem}
  .phase-risks{margin-top:.8rem;font-size:.9rem;color:#9a3b3b}
  .phase-risks ul{margin-left:1.2rem}
  table{width:100%;border-collapse:collapse;font-size:.9rem}
  th,td{text-align:left;padding:.55rem .7rem;border-bottom:1px solid #eef1f6;vertical-align:top}
  th{background:#f0f3fa;color:#0f3460}
  .check-item{display:flex;align-items:flex-start;gap:.6rem;padding:.45rem 0;cursor:pointer}
  .check-item input{margin-top:.35rem;width:1.05rem;height:1.05rem;flex-shrink:0}
  .phase-tag{color:#888;font-style:normal;font-size:.78rem;background:#eef1f6;padding:0 .4rem;border-radius:5px;margin-left:.3rem}
  .impact{padding:.1rem .5rem;border-radius:10px;font-size:.78rem;font-weight:600}
  .impact-high{background:#fde2e2;color:#c0392b}
  .impact-medium{background:#fff3d6;color:#b8860b}
  .impact-low{background:#e1f4e6;color:#27865a}
  ol.next{margin-left:1.2rem}
  ol.next li{margin:.3rem 0}
  @media(max-width:600px){.wrap{padding:1.2rem}header,section{padding:1.2rem}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${esc(m.title || 'Plan de Automatización')}</h1>
    <div class="meta">Creado: ${esc(fechaLegible)} · Versión ${esc(m.version || '1.0')}</div>
    ${m.businessContext ? `<div class="ctx">${esc(m.businessContext)}</div>` : ''}
  </header>

  <section>
    <h2>Resumen</h2>
    <div class="summary-grid">
      ${s.objective ? `<div><strong>Objetivo</strong>${esc(s.objective)}</div>` : ''}
      ${s.currentState ? `<div><strong>Estado actual</strong>${esc(s.currentState)}</div>` : ''}
      ${s.desiredState ? `<div><strong>Estado deseado</strong>${esc(s.desiredState)}</div>` : ''}
    </div>
  </section>

  <section>
    <h2>Fases de Implementación</h2>
    ${phasesHTML}
  </section>

  ${checklistHTML ? `<section><h2>Checklist de Ejecución</h2>${checklistHTML}</section>` : ''}

  ${toolsHTML ? `<section><h2>Herramientas</h2><table><thead><tr><th>Herramienta</th><th>Para qué</th><th>Coste</th></tr></thead><tbody>${toolsHTML}</tbody></table></section>` : ''}

  ${risksHTML ? `<section><h2>Riesgos y Mitigaciones</h2><table><thead><tr><th>Riesgo</th><th>Impacto</th><th>Mitigación</th></tr></thead><tbody>${risksHTML}</tbody></table></section>` : ''}

  ${nextStepsHTML ? `<section><h2>Siguientes Pasos</h2><ol class="next">${nextStepsHTML}</ol></section>` : ''}
</div>

<script>
  (function () {
    var KEY = ${JSON.stringify(storageKey)};
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { saved = {}; }
    var boxes = document.querySelectorAll('input[type="checkbox"][data-check-id]');
    boxes.forEach(function (box) {
      var id = box.getAttribute('data-check-id');
      if (saved[id]) box.checked = true;
      box.addEventListener('change', function () {
        saved[id] = box.checked;
        localStorage.setItem(KEY, JSON.stringify(saved));
      });
    });
  })();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Helpers de respuesta HTTP / CORS
// ---------------------------------------------------------------------------

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

function handleCORS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

async function handleGenerate(request, env) {
  try {
    const apiKey = env.ANTHROPIC_API_KEY;
    try {
      validarApiKey(apiKey);
    } catch {
      return jsonResponse({ success: false, error: 'API key no configurada' }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ success: false, error: 'El cuerpo de la petición no es JSON válido' }, 400);
    }

    const respuestas = body?.respuestas;
    if (!respuestas || typeof respuestas !== 'object' || Object.keys(respuestas).length !== 8) {
      return jsonResponse({ success: false, error: 'Faltan respuestas o están vacías' }, 400);
    }

    for (let i = 1; i <= 8; i++) {
      const valor = respuestas[i] ?? respuestas[String(i)];
      if (!valor || String(valor).trim().length < 3) {
        return jsonResponse({ success: false, error: `Respuesta ${i} muy corta o vacía` }, 400);
      }
    }

    const planText = await generarPlan(respuestas, apiKey);
    const plan = extraerJSON(planText);
    const html = generarHTML(plan);

    return jsonResponse({ success: true, plan, html }, 200);
  } catch (error) {
    const status = error.message === 'API key inválida' ? 401
      : error.message.startsWith('Límite') ? 429
      : 500;
    return jsonResponse({ success: false, error: error.message }, status);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    if (url.pathname === '/generate' && request.method === 'POST') {
      return handleGenerate(request, env);
    }

    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok' }, 200);
    }

    return jsonResponse({ success: false, error: 'Not found' }, 404);
  }
};
