import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());            // CORS para cualquier origen
app.use(express.json());

// ---------------------------------------------------------------------------
// Configuración de Anthropic
// ---------------------------------------------------------------------------

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 10000;
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

const JSON_SCHEMA = {
  metadata: {
    title: "string",
    createdAt: "ISO timestamp",
    businessContext: "string",
    version: "1.0"
  },
  analysis: {
    businessProfile: "string - resumen del perfil: tamano equipo, tipo negocio, nivel tecnico, presupuesto, madurez digital",
    rootCause: "string - causa raiz real del problema, no el sintoma descrito por el usuario",
    outOfScope: "string - que explicitamente no se va a resolver con este plan, para gestionar expectativas"
  },
  solutionsEvaluated: {
    options: [
      {
        name: "string - nombre de la herramienta o enfoque",
        pros: ["string"],
        cons: ["string"]
      }
    ],
    recommendation: "string - la opcion elegida entre las evaluadas",
    recommendationReasons: ["string - 2 a 4 motivos concretos ligados al perfil del negocio"]
  },
  summary: {
    objective: "string",
    currentState: "string",
    desiredState: "string"
  },
  phases: [
    {
      id: 1,
      name: "string",
      goal: "string",
      estimatedDuration: "string",
      tasks: [
        {
          id: "1.1",
          description: "string",
          tool: "string",
          noCodeAlternative: "string",
          estimatedEffort: "string",
          dependencies: []
        }
      ],
      risks: ["string"]
    }
  ],
  tools: [
    {
      name: "string",
      purpose: "string",
      cost: "string"
    }
  ],
  executionChecklist: [
    {
      id: "string",
      item: "string",
      phase: 1,
      done: false
    }
  ],
  nextSteps: ["string"],
  risksAndMitigations: [
    {
      risk: "string",
      impact: "high|medium|low",
      mitigation: "string"
    }
  ],
  viability: {
    score: "number 0-100",
    scoreJustification: "string - breve explicacion del score",
    prerequisites: ["string - que debe existir o decidirse antes de empezar"],
    validateBeforeSpending: ["string - 1 a 2 acciones concretas para validar antes de comprometer presupuesto"]
  }
};

const SYSTEM_PROMPT = `Eres un planificador experto en automatización de procesos con IA y herramientas no-code.

Vas a recibir las respuestas de un usuario a 8 preguntas sobre su negocio y el proceso que quiere automatizar. A partir de ellas, produce un plan de implementación completo, justificado y accionable.

ANTES de generar el JSON final, sigue este razonamiento interno en 5 pasos. El resultado de este razonamiento se refleja en los campos "analysis", "solutionsEvaluated" y "viability" del JSON, no como texto narrativo separado.

PASO 1 - PERFIL DEL NEGOCIO: A partir de las 8 respuestas, resume tamaño del equipo, tipo de negocio, nivel técnico, presupuesto y madurez digital. Esto determina qué soluciones tienen sentido (un equipo de 2 personas sin técnicos no recibe las mismas recomendaciones que uno con un desarrollador).

PASO 2 - ANÁLISIS DEL PROCESO: Identifica la causa raíz del problema, no solo el síntoma descrito por el usuario. Identifica también qué explícitamente NO es el problema, para evitar sobre-diseñar la solución.

PASO 3 - EVALUAR SOLUCIONES: Lista entre 2 y 4 opciones reales de herramientas o enfoques para resolver el proceso (ejemplo: Airtable vs Notion vs Monday, o Zapier vs Make vs n8n). Para cada una, da pros y contras honestos considerando el perfil del paso 1.

PASO 4 - DECIDIR: Elige UNA opción de las evaluadas en el paso 3 y justifica la elección en relación directa con presupuesto, nivel técnico y tamaño del equipo del paso 1. No elijas la opción "más potente" si no encaja con el perfil.

PASO 5 - VIABILIDAD: Evalúa qué tan realista es que ESTE cliente especifico implemente el plan. Da un score de 0 a 100, identifica los riesgos principales, los prerequisitos antes de empezar, y 1-2 acciones concretas que el cliente debería validar ANTES de comprometer presupuesto (ejemplo: "probar la herramienta gratis 2 semanas con datos reales antes de contratar el plan pago").

INSTRUCCIONES ESTRICTAS:
- Responde UNICAMENTE con un objeto JSON valido. Sin texto antes ni despues, sin bloques markdown, sin explicaciones.
- Sigue EXACTAMENTE este esquema JSON, incluyendo los campos "analysis", "solutionsEvaluated" y "viability":
${JSON.stringify(JSON_SCHEMA, null, 2)}
- Las fases del plan ("phases") deben ser coherentes con la opcion elegida en el paso 4: si recomiendas Airtable, las tareas deben usar Airtable, no Notion.
- Cada tarea debe nombrar una herramienta concreta y, cuando exista, una alternativa no-code real.
- Si una respuesta es vaga, haz la mejor suposicion razonable, pero no inventes datos criticos del negocio.
- En "createdAt" usa un timestamp ISO 8601.
- Escribe todo el contenido en espanol, sin guiones largos.`;

// ---------------------------------------------------------------------------
// Lógica de generación (portada desde el Worker)
// ---------------------------------------------------------------------------

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
      }),
      signal: AbortSignal.timeout(120000)
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
  console.log('[Express] texto crudo (primeros 500):', textoCrudo.substring(0, 500));

  let limpio = textoCrudo
    .trim()
    .replace(/^﻿/, '')
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();

  const inicio = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}');
  if (inicio === -1 || fin === -1 || fin <= inicio) {
    console.error('[Express] no se encontró objeto JSON. Texto limpio:', limpio.substring(0, 300));
    throw new Error(`La respuesta de Claude no contiene un objeto JSON válido. Inicio del texto: ${textoCrudo.substring(0, 200)}`);
  }
  if (inicio > 0 || fin < limpio.length - 1) {
    limpio = limpio.slice(inicio, fin + 1);
  }

  let plan;
  try {
    plan = JSON.parse(limpio);
  } catch (err) {
    console.error('[Express] JSON.parse falló:', err.message);
    console.error('[Express] texto completo enviado a parse:', limpio);
    throw new Error(`JSON inválido (${err.message}). Texto crudo (primeros 300): ${textoCrudo.substring(0, 300)}`);
  }

  const faltantes = [];
  if (!plan.metadata || typeof plan.metadata !== 'object') faltantes.push('metadata');
  if (!Array.isArray(plan.phases) || plan.phases.length === 0) faltantes.push('phases (array no vacío)');
  if (!Array.isArray(plan.executionChecklist)) faltantes.push('executionChecklist');

  if (faltantes.length > 0) {
    console.error('[Express] campos faltantes:', faltantes);
    throw new Error(`Plan generado incompleto (faltan: ${faltantes.join(', ')})`);
  }

  // Campos de razonamiento: advertencia, no bloqueo
  const razonamientoFaltante = [];
  if (!plan.analysis || typeof plan.analysis !== 'object') razonamientoFaltante.push('analysis');
  if (!plan.solutionsEvaluated || typeof plan.solutionsEvaluated !== 'object') razonamientoFaltante.push('solutionsEvaluated');
  if (!plan.viability || typeof plan.viability !== 'object') razonamientoFaltante.push('viability');
  if (razonamientoFaltante.length > 0) {
    console.warn('[Express] ⚠ faltan campos de razonamiento:', razonamientoFaltante.join(', '));
  }

  console.log('[Express] plan válido — fases:', plan.phases.length, '| checklist items:', plan.executionChecklist.length, '| razonamiento:', razonamientoFaltante.length === 0 ? 'completo' : `faltan ${razonamientoFaltante.join(',')}`);
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
  const a = plan.analysis || {};
  const se = plan.solutionsEvaluated || {};
  const v = plan.viability || {};
  const phases = plan.phases || [];
  const tools = plan.tools || [];
  const checklist = plan.executionChecklist || [];
  const nextSteps = plan.nextSteps || [];
  const risks = plan.risksAndMitigations || [];

  const fechaLegible = m.createdAt ? new Date(m.createdAt).toLocaleString('es-ES') : '';

  // --- Análisis del Negocio ---
  const analysisHTML = (a.businessProfile || a.rootCause || a.outOfScope)
    ? `<section>
    <h2>Análisis del Negocio</h2>
    ${a.businessProfile ? `<div class="analysis-block"><strong>Perfil del negocio</strong><p>${esc(a.businessProfile)}</p></div>` : ''}
    ${a.rootCause ? `<div class="root-cause"><strong>Causa raíz del problema</strong><p>${esc(a.rootCause)}</p></div>` : ''}
    ${a.outOfScope ? `<div class="out-scope"><strong>Qué no se va a resolver</strong><p>${esc(a.outOfScope)}</p></div>` : ''}
  </section>`
    : '';

  // --- Opciones Evaluadas ---
  const options = Array.isArray(se.options) ? se.options : [];
  const optionsHTML = options.map((o) => `
      <div class="option-card">
        <h3>${esc(o.name)}</h3>
        <div class="pros"><strong>Pros</strong><ul>${(o.pros || []).map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>
        <div class="cons"><strong>Contras</strong><ul>${(o.cons || []).map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>
      </div>`).join('');
  const recommendationHTML = se.recommendation
    ? `<div class="recommendation"><strong>Recomendación: ${esc(se.recommendation)}</strong><ul>${(se.recommendationReasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>`
    : '';
  const solutionsHTML = (options.length || se.recommendation)
    ? `<section>
    <h2>Opciones Evaluadas</h2>
    ${options.length ? `<div class="options-grid">${optionsHTML}</div>` : ''}
    ${recommendationHTML}
  </section>`
    : '';

  // --- Viabilidad ---
  const scoreNum = Number(v.score);
  const scoreClass = !Number.isFinite(scoreNum) ? 'score-mid'
    : scoreNum >= 70 ? 'score-high'
    : scoreNum >= 40 ? 'score-mid'
    : 'score-low';
  const prerequisites = Array.isArray(v.prerequisites) ? v.prerequisites : [];
  const validateBefore = Array.isArray(v.validateBeforeSpending) ? v.validateBeforeSpending : [];
  const viabilityHTML = (v.score !== undefined || v.scoreJustification || prerequisites.length || validateBefore.length)
    ? `<section>
    <h2>Viabilidad</h2>
    <div class="viability-head">
      <span class="score-badge ${scoreClass}">${esc(v.score ?? '?')}<small>/100</small></span>
      ${v.scoreJustification ? `<p>${esc(v.scoreJustification)}</p>` : ''}
    </div>
    ${prerequisites.length ? `<div class="via-prereq"><strong>Prerequisitos</strong><ul>${prerequisites.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
    ${validateBefore.length ? `<div class="validate-block"><strong>Antes de gastar dinero, valida esto:</strong><ul>${validateBefore.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
  </section>`
    : '';

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
  .analysis-block,.root-cause,.out-scope{padding:.9rem 1rem;border-radius:8px;margin-bottom:.8rem}
  .analysis-block{background:#f4f6fb}
  .root-cause{background:#eef4ff;border-left:4px solid #0f3460}
  .out-scope{background:#fbf7ee;border-left:4px solid #b8860b}
  .analysis-block strong,.root-cause strong,.out-scope strong{display:block;color:#0f3460;margin-bottom:.3rem}
  .options-grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
  .option-card{border:1px solid #e3e7f0;border-radius:10px;padding:1rem}
  .option-card h3{font-size:1rem;color:#1b2a4a;margin-bottom:.6rem}
  .option-card .pros strong,.option-card .cons strong{display:block;margin-bottom:.25rem}
  .option-card .pros strong{color:#27865a}
  .option-card .cons strong{color:#c0392b}
  .option-card ul{list-style:none;margin:.2rem 0 .7rem}
  .option-card li{font-size:.86rem;margin:.15rem 0}
  .option-card .pros li::before{content:"+ ";color:#27865a;font-weight:700}
  .option-card .cons li::before{content:"− ";color:#c0392b;font-weight:700}
  .recommendation{margin-top:1rem;padding:1rem 1.2rem;background:#e1f4e6;border-left:4px solid #27865a;border-radius:8px}
  .recommendation strong{display:block;color:#1b6e45;margin-bottom:.4rem;font-size:1.02rem}
  .recommendation ul{margin-left:1.2rem}
  .viability-head{display:flex;align-items:center;gap:1.2rem;margin-bottom:1rem;flex-wrap:wrap}
  .score-badge{display:inline-flex;align-items:baseline;justify-content:center;min-width:84px;padding:.6rem 1rem;border-radius:12px;font-size:1.8rem;font-weight:700;color:#fff}
  .score-badge small{font-size:.85rem;font-weight:500;opacity:.85;margin-left:2px}
  .score-high{background:#27865a}
  .score-mid{background:#b8860b}
  .score-low{background:#c0392b}
  .viability-head p{flex:1;min-width:200px;color:#444}
  .via-prereq{margin-top:.5rem}
  .via-prereq strong{display:block;color:#0f3460;margin-bottom:.3rem}
  .via-prereq ul,.validate-block ul{margin-left:1.2rem}
  .validate-block{margin-top:.9rem;padding:1rem 1.2rem;background:#fff3d6;border-left:4px solid #b8860b;border-radius:8px}
  .validate-block strong{display:block;color:#8a6400;margin-bottom:.4rem}
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

  ${analysisHTML}

  ${solutionsHTML}

  <section>
    <h2>Fases de Implementación</h2>
    ${phasesHTML}
  </section>

  ${checklistHTML ? `<section><h2>Checklist de Ejecución</h2>${checklistHTML}</section>` : ''}

  ${toolsHTML ? `<section><h2>Herramientas</h2><table><thead><tr><th>Herramienta</th><th>Para qué</th><th>Coste</th></tr></thead><tbody>${toolsHTML}</tbody></table></section>` : ''}

  ${risksHTML ? `<section><h2>Riesgos y Mitigaciones</h2><table><thead><tr><th>Riesgo</th><th>Impacto</th><th>Mitigación</th></tr></thead><tbody>${risksHTML}</tbody></table></section>` : ''}

  ${viabilityHTML}

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
// Rutas
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'automation-planner-express' });
});

app.post('/generate', async (req, res) => {
  try {
    const { respuestas } = req.body ?? {};

    if (!respuestas || typeof respuestas !== 'object' || Object.keys(respuestas).length !== 8) {
      return res.status(400).json({ success: false, error: 'Faltan respuestas o están vacías' });
    }

    for (let i = 1; i <= 8; i++) {
      const valor = respuestas[i] ?? respuestas[String(i)];
      if (!valor || String(valor).trim().length < 3) {
        return res.status(400).json({ success: false, error: `Respuesta ${i} muy corta o vacía` });
      }
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || !apiKey.startsWith('sk-ant-')) {
      return res.status(500).json({ success: false, error: 'API key no configurada' });
    }

    const planText = await generarPlan(respuestas, apiKey);
    const plan = extraerJSON(planText);
    const html = generarHTML(plan);

    return res.json({ success: true, plan, html });
  } catch (error) {
    console.error('[Express] Error:', error.message);
    const status = error.message === 'API key inválida' ? 401
      : error.message.startsWith('Límite') ? 429
      : 500;
    return res.status(status).json({ success: false, error: error.message });
  }
});

app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`[Express] Automation Planner escuchando en http://localhost:${PORT}`);
});
