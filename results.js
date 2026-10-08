/**
 * results.js
 * صفحة نتائج الامتحان الخاصة بالأستاذ: قائمة الطلاب، تصحيح تلقائي
 * للأسئلة الموضوعية، وتصحيح يدوي للأسئلة المقالية.
 */

let rctx = {
  examId: null,
  exam: null,
  questions: [],
  answerKeys: {}, // questionId -> answerKey data
  attempts: [],
  violationsByAttempt: {}, // attemptId -> [violation, ...] مرتّبة زمنيًا
  answersByAttempt: {}, // attemptId -> { questionId -> answerData(+id) } (تُحمَّل مرة واحدة وتُحدَّث في الذاكرة)
  questionsById: new Map(),
  grades: {}, // attemptId -> درجة يكتبها الأستاذ فقط (المصدر الوحيد الموثوق للدرجات)
};

/** يشغّل المهام بالتوازي بحد أقصى معيّن (بدل الانتظار المتسلسل) */
async function runPool(tasks, limit = 8) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      await tasks[i]();
    }
  });
  await Promise.all(workers);
}

/** الدرجات التي كتبها الأستاذ (الطالب لا يملك صلاحية الكتابة في هذه المجموعة) */
async function loadGrades() {
  const snap = await db.collection(COLLECTIONS.GRADES).where("examId", "==", rctx.examId).get();
  rctx.grades = {};
  snap.docs.forEach((d) => {
    const g = d.data();
    if (g && d.id === g.attemptId) rctx.grades[d.id] = g;
  });
}

/** تنزيل إجابات هذا الامتحان مرة واحدة فقط وتجميعها حسب المحاولة */
async function loadAnswers() {
  const snap = await db.collection(COLLECTIONS.ANSWERS).where("examId", "==", rctx.examId).get();
  const map = {};
  snap.docs.forEach((d) => {
    const a = { id: d.id, ...d.data() };
    // تجاهل أي مستند معرّفه لا يطابق (محاولة + سؤال) فعليين: يمنع الحشو والانتحال
    if (d.id !== `${a.attemptId}_${a.questionId}` || !rctx.questionsById.has(a.questionId)) return;
    // الحقول التالية قد يكون الطالب كتبها بنفسه، فلا نثق بها أبدًا
    delete a.autoScore; delete a.isCorrect; delete a.teacherScore;
    const g = rctx.grades[a.attemptId] && rctx.grades[a.attemptId].answers && rctx.grades[a.attemptId].answers[a.questionId];
    if (g) Object.assign(a, g);
    (map[a.attemptId] = map[a.attemptId] || {})[a.questionId] = a;
  });
  rctx.answersByAttempt = map;
}

function stripId(obj) {
  const { id, ...rest } = obj;
  return rest;
}

guardTeacherPage(async (teacher) => {
  const chip = document.getElementById("userChip");
  if (chip) chip.textContent = `${teacher.name || teacher.email} 👋`;

  const params = new URLSearchParams(window.location.search);
  rctx.examId = params.get("exam");
  const alertBox = document.getElementById("alertBox");

  if (!rctx.examId) {
    showAlert(alertBox, "لم يتم تحديد امتحان.", "error");
    return;
  }

  try {
    const examDoc = await db.collection(COLLECTIONS.EXAMS).doc(rctx.examId).get();
    if (!examDoc.exists) {
      showAlert(alertBox, "لا تملك صلاحية الوصول لنتائج هذا الامتحان.", "error");
      return;
    }
    rctx.exam = examDoc.data();
    document.getElementById("examTitleHeader").textContent = `نتائج: ${rctx.exam.title}`;

    const [qSnap, keysSnap] = await Promise.all([
      db.collection(COLLECTIONS.QUESTIONS).where("examId", "==", rctx.examId).orderBy("order").get(),
      db.collection(COLLECTIONS.ANSWER_KEYS).where("examId", "==", rctx.examId).get(), // للأستاذ صاحب الامتحان فقط عبر القواعد
      loadGrades(),
    ]);
    rctx.questions = qSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    rctx.questionsById = new Map(rctx.questions.map((q) => [q.id, q]));
    keysSnap.forEach((d) => (rctx.answerKeys[d.id] = d.data()));
    await Promise.all([loadAttempts(), loadAnswers()]);

    document.getElementById("autoGradeBtn").addEventListener("click", runAutoGrade);
    document.getElementById("backToListBtn").addEventListener("click", showListView);
  } catch (err) {
    console.error(err);
    showAlert(alertBox, translateError(err), "error");
  }
});

async function loadAttempts() {
  const snap = await db.collection(COLLECTIONS.ATTEMPTS).where("examId", "==", rctx.examId).get();
  rctx.attempts = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    // معرّف المحاولة يجب أن يطابق (امتحان + طالب) وإلا تُتجاهل (منع الحشو)
    .filter((a) => a.id === `${a.examId}_${a.studentUid}`)
    .map((a) => {
      // الدرجة والحالة النهائية تأتيان من سجل الأستاذ فقط، لا مما كتبه الطالب
      const g = rctx.grades[a.id];
      a.totalScore = g ? Number(g.totalScore) || 0 : 0;
      a.maxScore = g ? Number(g.maxScore) || 0 : 0;
      a.status = a.status === "in_progress" ? "in_progress" : g ? g.status : "submitted";
      return a;
    });
  rctx.attempts.sort((a, b) => tsMsSafe(b.startedAt) - tsMsSafe(a.startedAt));

  // سجل المخالفات (خروج من الامتحان، نسخ/لصق، محاولة دخول بعد التسليم...)
  const vSnap = await db.collection(COLLECTIONS.VIOLATIONS).where("examId", "==", rctx.examId).get();
  rctx.violationsByAttempt = {};
  vSnap.docs.forEach((d) => {
    const v = { id: d.id, ...d.data() };
    // معرّف المخالفة = معرّف المحاولة + "_" + لاحقة بسيطة بلا شرطة سفلية، وإلا تُتجاهل
    if (!v.attemptId || !d.id.startsWith(v.attemptId + "_") || d.id.slice(v.attemptId.length + 1).includes("_")) return;
    (rctx.violationsByAttempt[v.attemptId] = rctx.violationsByAttempt[v.attemptId] || []).push(v);
  });
  Object.values(rctx.violationsByAttempt).forEach((list) => list.sort((a, b) => tsMsSafe(a.timestamp) - tsMsSafe(b.timestamp)));

  renderStats();
  renderAttemptsTable();
}

function violationTotal(attempt) {
  const logged = (rctx.violationsByAttempt[attempt.id] || []).length;
  return Math.max(Number(attempt.violationCount) || 0, logged);
}

function tsMsSafe(v) {
  const ms = toMs(v);
  return isNaN(ms) ? 0 : ms;
}

function renderStats() {
  const total = rctx.attempts.length;
  const graded = rctx.attempts.filter((a) => a.status === "graded").length;
  const pending = rctx.attempts.filter((a) => a.status !== "graded").length;
  const gradedOnes = rctx.attempts.filter((a) => a.status === "graded" && a.maxScore > 0);
  const avg = gradedOnes.length
    ? Math.round((gradedOnes.reduce((s, a) => s + a.totalScore / a.maxScore, 0) / gradedOnes.length) * 100)
    : 0;
  const nums = document.querySelectorAll("#resultsStatGrid .num");
  const values = [total, graded, pending, gradedOnes.length ? `${avg}%` : "—"];
  nums.forEach((el, i) => (el.textContent = values[i]));
}

function renderAttemptsTable() {
  const tbody = document.getElementById("attemptsTbody");
  if (rctx.attempts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">لم يدخل أي طالب هذا الامتحان بعد.</td></tr>`;
    return;
  }
  tbody.innerHTML = "";
  rctx.attempts.forEach((attempt) => {
    const tr = document.createElement("tr");
    tr.className = "row-link";
    const scoreLabel =
      attempt.status === "graded"
        ? `${attempt.totalScore} / ${attempt.maxScore}`
        : attempt.status === "submitted"
        ? "بانتظار التصحيح"
        : "—";
    tr.innerHTML = `
      <td>${escapeHtml(attempt.studentName)}</td>
      <td class="ltr">${formatDateTime(attempt.startedAt)}</td>
      <td class="ltr">${attempt.submittedAt ? formatDateTime(attempt.submittedAt) : "—"}</td>
      <td>${scoreLabel}</td>
      <td>${violationTotal(attempt) > 0 ? `<span class="viol-badge">${violationTotal(attempt)}</span>` : "0"}</td>
      <td>${attemptStatusBadge(attempt.status)}</td>
    `;
    tr.addEventListener("click", () => showDetailView(attempt.id));
    tbody.appendChild(tr);
  });
}

function attemptStatusBadge(status) {
  const map = {
    in_progress: ["جارٍ", "progress"],
    submitted: ["تم التسليم", "submitted"],
    graded: ["تم التصحيح", "graded"],
  };
  const [label, cls] = map[status] || [status, "draft"];
  return `<span class="badge badge-${cls}">${label}</span>`;
}

/* ---------------------- التصحيح التلقائي ---------------------- */

function isCorrectObjective(question, answerValue) {
  const key = rctx.answerKeys[question.id];
  if (!key) return false;
  if (question.type === "multiple_choice" || question.type === "true_false") {
    return answerValue === key.correctAnswer;
  }
  if (question.type === "short_answer") {
    const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
    return (key.acceptableAnswers || []).some((a) => norm(a) === norm(answerValue));
  }
  return false;
}

/** يحسب مجموع المحاولة وحالتها من الإجابات الموجودة في الذاكرة (بدون أي طلب شبكة) */
function computeAttemptScore(answersByQ) {
  let total = 0;
  let pendingEssay = 0;
  rctx.questions.forEach((q) => {
    const ans = answersByQ[q.id];
    if (q.type === "essay") {
      if (ans && typeof ans.teacherScore === "number") total += ans.teacherScore;
      else pendingEssay += 1;
    } else if (ans && typeof ans.autoScore === "number") {
      total += ans.autoScore; // موضوعي بدون تصحيح بعد يُحتسب صفرًا مؤقتًا وليس "معلقًا"
    }
  });
  return { total, status: pendingEssay === 0 ? "graded" : "submitted" };
}

/** يبني سجل الدرجة الذي يُكتب في مجموعة grades */
function buildGrade(attempt, answersByQ) {
  const { total, status } = computeAttemptScore(answersByQ);
  const answers = {};
  Object.entries(answersByQ).forEach(([qid, a]) => {
    const o = {};
    if (typeof a.autoScore === "number") { o.autoScore = a.autoScore; o.isCorrect = !!a.isCorrect; }
    if (typeof a.teacherScore === "number") o.teacherScore = a.teacherScore;
    if (Object.keys(o).length) answers[qid] = o;
  });
  const maxScore = rctx.questions.reduce((sum, q) => sum + (Number(q.points) || 0), 0);
  return { attemptId: attempt.id, examId: rctx.examId, studentUid: attempt.studentUid, totalScore: total, maxScore, status, answers };
}

async function runAutoGrade() {
  const btn = document.getElementById("autoGradeBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> جاري التصحيح...';
  try {
    // تحديث البيانات ثم كل الحساب في الذاكرة؛ النتيجة تُكتب في سجل الدرجات (للأستاذ فقط)
    await loadGrades();
    await Promise.all([loadAttempts(), loadAnswers()]);

    const writes = [];
    for (const attempt of rctx.attempts) {
      if (attempt.status === "in_progress") continue; // لا نصحح محاولة لم تُسلَّم بعد
      const answersByQ = rctx.answersByAttempt[attempt.id] || {};

      Object.values(answersByQ).forEach((answer) => {
        const question = rctx.questionsById.get(answer.questionId);
        if (!question || question.type === "essay") return;
        const correct = isCorrectObjective(question, answer.answerValue);
        answer.autoScore = correct ? Number(question.points) || 0 : 0;
        answer.isCorrect = correct;
      });

      const grade = buildGrade(attempt, answersByQ);
      if (JSON.stringify(rctx.grades[attempt.id] || null) !== JSON.stringify(grade)) {
        rctx.grades[attempt.id] = grade;
        attempt.totalScore = grade.totalScore;
        attempt.maxScore = grade.maxScore;
        attempt.status = grade.status;
        writes.push(() => db.collection(COLLECTIONS.GRADES).doc(attempt.id).set(grade));
      }
    }

    await runPool(writes, 8); // كتابات متوازية، كل واحدة طلب PUT واحد
    renderStats();
    renderAttemptsTable();
    showAlert(document.getElementById("alertBox"), "تم تصحيح جميع الأسئلة الموضوعية بنجاح.", "success");
  } catch (err) {
    console.error(err);
    showAlert(document.getElementById("alertBox"), translateError(err), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "تصحيح تلقائي للأسئلة الموضوعية";
  }
}

/* ---------------------- عرض تفاصيل محاولة طالب ---------------------- */

function showListView() {
  document.getElementById("listView").classList.remove("hidden");
  document.getElementById("detailView").classList.add("hidden");
}

async function showDetailView(attemptId) {
  const attempt = rctx.attempts.find((a) => a.id === attemptId);
  document.getElementById("listView").classList.add("hidden");
  document.getElementById("detailView").classList.remove("hidden");
  document.getElementById("detailStudentName").textContent = attempt.studentName;
  document.getElementById("detailMeta").textContent =
    `دخل: ${formatDateTime(attempt.startedAt)} — سلّم: ${attempt.submittedAt ? formatDateTime(attempt.submittedAt) : "لم يسلّم بعد"} — مخالفات: ${violationTotal(attempt)}`;
  renderViolationLog(attempt);

  const answersByQ = rctx.answersByAttempt[attemptId] || {};

  const container = document.getElementById("detailQuestions");
  container.innerHTML = "";

  rctx.questions.forEach((q, index) => {
    const answer = answersByQ[q.id];
    const key = rctx.answerKeys[q.id];
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="muted small">السؤال ${index + 1} — ${typeLabelAr(q.type)} — (${Number(q.points) || 0} ${q.points === 1 ? "درجة" : "درجات"})</div>
      <div class="ltr mt-8" style="direction:ltr; text-align:left; font-weight:500;">${escapeHtml(q.text)}</div>
      <div class="mt-16"><strong>إجابة الطالب:</strong> <span class="ltr">${formatAnswerForDisplay(q, answer)}</span></div>
      ${q.type !== "essay" ? `<div class="mt-8"><strong>الإجابة الصحيحة (تظهر للأستاذ فقط):</strong> <span class="ltr">${formatCorrectAnswer(q, key)}</span></div>` : ""}
      <div class="mt-8" id="score-row-${escapeHtml(q.id)}"></div>
    `;
    const scoreRow = card.querySelector(`[id="score-row-${CSS.escape(q.id)}"]`);
    if (q.type === "essay") {
      const current = answer?.teacherScore ?? "";
      scoreRow.innerHTML = `
        <div class="form-row" style="align-items:flex-end;">
          <div class="field" style="max-width:140px;">
            <label>الدرجة (من ${Number(q.points) || 0})</label>
            <input type="number" min="0" max="${Number(q.points) || 0}" step="0.5" id="essayScore-${escapeHtml(q.id)}" value="${escapeHtml(current)}" />
          </div>
          <button class="btn btn-primary btn-sm" data-act="save-essay" data-qid="${escapeHtml(q.id)}">حفظ الدرجة</button>
        </div>
      `;
      scoreRow.querySelector('[data-act="save-essay"]').addEventListener("click", () => saveEssayScore(attemptId, q, answer));
    } else {
      const score = answer && typeof answer.autoScore === "number" ? answer.autoScore : "لم يُصحَّح بعد";
      scoreRow.innerHTML = `<strong>الدرجة:</strong> ${score} ${typeof score === "number" ? `/ ${Number(q.points) || 0}` : ""}`;
    }
    container.appendChild(card);
  });
}

function renderViolationLog(attempt) {
  const box = document.getElementById("detailViolations");
  const list = rctx.violationsByAttempt[attempt.id] || [];
  if (list.length === 0) {
    box.innerHTML = `<div class="card"><h3 class="mb-0">سجل المخالفات</h3><p class="muted small mb-0 mt-8">لا توجد مخالفات مسجَّلة لهذا الطالب.</p></div>`;
    return;
  }
  const items = list
    .map((v) => {
      const extras = [];
      if (v.durationSec) extras.push(`مدة الغياب: ${formatCountdown(v.durationSec)}`);
      if (v.attemptedName) extras.push(`الاسم المُدخل: ${escapeHtml(v.attemptedName)}${v.differentName ? " (اسم مختلف)" : ""}`);
      return `<li>
        <span><strong>${escapeHtml(violationLabelAr(v.type))}</strong>${extras.length ? `<br><span class="muted small">${extras.join(" — ")}</span>` : ""}</span>
        <span class="when ltr">${formatDateTimeSec(v.timestamp)}</span>
      </li>`;
    })
    .join("");
  box.innerHTML = `<div class="card"><h3 class="mb-0">سجل المخالفات (${list.length})</h3><ul class="viol-list">${items}</ul></div>`;
}

function typeLabelAr(type) {
  return { multiple_choice: "اختيار من متعدد", true_false: "صح / خطأ", short_answer: "إجابة قصيرة", essay: "مقالي" }[type] || type;
}

function formatAnswerForDisplay(question, answer) {
  if (!answer || answer.answerValue === undefined || answer.answerValue === "") return "لم يُجب";
  if (question.type === "multiple_choice") {
    const letter = answer.answerValue;
    const text = question.options?.[letter] || "";
    return `${letter.toUpperCase()} — ${escapeHtml(text)}`;
  }
  if (question.type === "true_false") {
    return answer.answerValue === "true" ? "True" : "False";
  }
  return escapeHtml(answer.answerValue);
}

function formatCorrectAnswer(question, key) {
  if (!key) return "—";
  if (question.type === "multiple_choice") {
    const letter = key.correctAnswer;
    return `${letter.toUpperCase()} — ${escapeHtml(question.options?.[letter] || "")}`;
  }
  if (question.type === "true_false") {
    return key.correctAnswer === "true" ? "True" : "False";
  }
  if (question.type === "short_answer") {
    return (key.acceptableAnswers || []).map(escapeHtml).join(" / ");
  }
  return "—";
}

async function saveEssayScore(attemptId, question, existingAnswer) {
  const input = document.getElementById(`essayScore-${question.id}`);
  let score = Number(input.value);
  if (isNaN(score) || score < 0) score = 0;
  if (score > question.points) score = question.points;
  input.value = score;

  const answerId = `${attemptId}_${question.id}`;
  const attempt = rctx.attempts.find((a) => a.id === attemptId);
  const answersByQ = (rctx.answersByAttempt[attemptId] = rctx.answersByAttempt[attemptId] || {});
  const answer = {
    ...(answersByQ[question.id] || {}),
    id: answerId,
    attemptId,
    examId: rctx.examId,
    questionId: question.id,
    studentUid: existingAnswer?.studentUid || null,
    answerValue: existingAnswer?.answerValue || "",
    teacherScore: score,
  };
  answersByQ[question.id] = answer;

  const grade = buildGrade(attempt, answersByQ);
  rctx.grades[attemptId] = grade;
  attempt.totalScore = grade.totalScore;
  attempt.maxScore = grade.maxScore;
  attempt.status = grade.status;

  // كتابة واحدة في سجل الدرجات (الأستاذ فقط)؛ لا نلمس مستندات الطالب
  await db.collection(COLLECTIONS.GRADES).doc(attemptId).set(grade);

  renderStats();
  renderAttemptsTable();
  showAlert(document.getElementById("alertBox"), "تم حفظ درجة السؤال المقالي.", "success");
  showDetailView(attemptId);
}
