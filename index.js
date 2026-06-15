import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const SYSTEM_PROMPT = `Eres un planificador experto en automatización de procesos con IA y herramientas no-code.

Vas a recibir las respuestas de un usuario a 8 preguntas sobre su negocio y el proceso que quiere automatizar. A partir de ellas, produce un plan de implementación completo y accionable.

INSTRUCCIONES ESTRICTAS:
- Responde ÚNICAMENTE con un objeto JSON válido. Sin texto antes ni después, sin bloques markdown, sin explicaciones.
- Sigue EXACTAMENTE este esquema:
${JSON_SCHEMA}
- Divide el plan en fases lógicas y ordenadas.
- Cada tarea debe nombrar una herramienta concreta y, cuando exista, una alternativa no-code real.
- Ajusta las herramientas y el presupuesto al nivel técnico y a las preferencias indicadas.
- Si una respuesta es vaga, haz la mejor suposición razonable, pero no inventes datos críticos del negocio.
- En "createdAt" usa un timestamp ISO 8601.
- Escribe todo el contenido en español, sin guiones largos.`;

function validarApiKey() {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    console.error('\n  No se encontró una API key válida de Anthropic.\n');
    console.error('  Pasos para configurarla:');
    console.error('    1. Copia el archivo .env.example a .env');
    console.error('    2. Abre .env y pon tu clave real:');
    console.error('         ANTHROPIC_API_KEY=sk-ant-...');
    console.error('    3. Obtén tu clave en https://console.anthropic.com/account/keys');
    console.error('    4. Ejecuta de nuevo con: npm start\n');
    process.exit(1);
  }
  return apiKey;
}

function hacerPregunta(rl, texto) {
  return new Promise((resolve) => rl.question(texto, (respuesta) => resolve(respuesta.trim())));
}

async function recolectarRespuestas(rl, preguntas) {
  const respuestas = {};
  for (let i = 0; i < preguntas.length; i++) {
    console.log(`\n── Pregunta ${i + 1}/${preguntas.length} ──`);
    let respuesta = '';
    while (true) {
      respuesta = await hacerPregunta(rl, `${preguntas[i]}\n> `);
      if (respuesta.length >= 3) break;
      console.log('  La respuesta es demasiado corta. Da algo más de detalle (mínimo 3 caracteres).');
    }
    respuestas[`pregunta${i + 1}`] = { pregunta: preguntas[i], respuesta };
  }
  return respuestas;
}

async function generarPlan(respuestas, apiKey) {
  const contenidoUsuario = Object.values(respuestas)
    .map((r, i) => `${i + 1}. ${r.pregunta}\nRespuesta: ${r.respuesta}`)
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
    throw new Error(`No se pudo conectar con la API de Anthropic (problema de red): ${err.message}. Revisa tu conexión e inténtalo de nuevo.`);
  }

  if (!response.ok) {
    let detalle = '';
    try {
      const errBody = await response.json();
      detalle = errBody?.error?.message || JSON.stringify(errBody);
    } catch {
      detalle = await response.text().catch(() => '');
    }
    throw new Error(`La API respondió con error HTTP ${response.status}. Motivo: ${detalle || 'desconocido'}. Inténtalo de nuevo en unos segundos.`);
  }

  const data = await response.json();
  const texto = data?.content?.[0]?.text;
  if (!texto || !texto.trim()) {
    throw new Error('La API devolvió una respuesta vacía. No hay nada que procesar; inténtalo de nuevo.');
  }
  return texto;
}

function extraerJSON(textoCrudo) {
  let limpio = textoCrudo.trim();
  limpio = limpio.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  // Si hay texto alrededor, recorta al primer { y último }.
  const inicio = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}');
  if (inicio > 0 || fin < limpio.length - 1) {
    if (inicio !== -1 && fin !== -1) limpio = limpio.slice(inicio, fin + 1);
  }

  let plan;
  try {
    plan = JSON.parse(limpio);
  } catch (err) {
    throw new Error(`La respuesta de la API no es JSON válido (${err.message}).\nPrimeros caracteres recibidos:\n${textoCrudo.slice(0, 300)}`);
  }

  const faltantes = [];
  if (!plan.metadata) faltantes.push('metadata');
  if (!Array.isArray(plan.phases) || plan.phases.length === 0) faltantes.push('phases (array no vacío)');
  if (!Array.isArray(plan.executionChecklist)) faltantes.push('executionChecklist');
  if (faltantes.length > 0) {
    throw new Error(`El JSON del plan no incluye campos obligatorios: ${faltantes.join(', ')}.`);
  }
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

function guardarArchivos(plan, html) {
  const plansDir = path.join(__dirname, 'plans');
  try {
    if (!fs.existsSync(plansDir)) fs.mkdirSync(plansDir, { recursive: true });
  } catch (err) {
    throw new Error(`No se pudo crear la carpeta ${plansDir}: ${err.message}`);
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const jsonPath = path.join(plansDir, `plan-${ts}.json`);
  const htmlPath = path.join(plansDir, `plan-${ts}.html`);

  try {
    fs.writeFileSync(jsonPath, JSON.stringify(plan, null, 2), 'utf-8');
    fs.writeFileSync(htmlPath, html, 'utf-8');
  } catch (err) {
    throw new Error(`No se pudieron escribir los archivos en ${plansDir}: ${err.message}`);
  }
  return { jsonPath, htmlPath };
}

async function main() {
  const apiKey = validarApiKey();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n=============================================');
  console.log('  AUTOMATION PLANNER');
  console.log('  Planes de automatización a partir de 8 preguntas');
  console.log('=============================================');

  try {
    const respuestas = await recolectarRespuestas(rl, PREGUNTAS);
    rl.close();

    console.log('\nGenerando tu plan de automatización con IA...\n');
    const textoCrudo = await generarPlan(respuestas, apiKey);
    const plan = extraerJSON(textoCrudo);
    const html = generarHTML(plan);
    const { jsonPath, htmlPath } = guardarArchivos(plan, html);

    console.log('=============================================');
    console.log('  Plan generado correctamente');
    console.log('=============================================');
    console.log(`  JSON: ${jsonPath}`);
    console.log(`  HTML: ${htmlPath}`);
    console.log(`\n  Fases: ${plan.phases.length} · Checklist: ${(plan.executionChecklist || []).length} items`);
    console.log('  Abre el HTML en tu navegador para ver el plan.');
    console.log('=============================================\n');
  } catch (err) {
    if (!rl.closed) rl.close();
    console.error('\n  No se pudo completar el plan.');
    console.error(`  ${err.message}\n`);
    process.exit(1);
  }
}

main();
