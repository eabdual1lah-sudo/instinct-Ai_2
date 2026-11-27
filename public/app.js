const $ = (selector) => document.querySelector(selector);
const conversation = $("#conversation");
const welcome = $("#welcome");
const form = $("#chat-form");
const input = $("#message");
const send = $("#send");
const sessionKey = "instinct_session_v1";
let sessionId = localStorage.getItem(sessionKey);
if (!sessionId) {
  sessionId = crypto.randomUUID().replaceAll("-", "");
  localStorage.setItem(sessionKey, sessionId);
}

function addMessage(role, text, extra = "") {
  welcome?.remove();
  const node = document.createElement("div");
  node.className = `message ${role} ${extra}`.trim();
  node.textContent = text;
  conversation.appendChild(node);
  node.scrollIntoView({ behavior: "smooth", block: "end" });
  return node;
}

async function checkHealth() {
  const label = $("#connection");
  const dot = $("#status-dot");
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    if (data.ok && data.apiKeyConfigured) {
      label.textContent = "متصل وجاهز";
      dot.classList.add("online");
    } else {
      label.textContent = "في انتظار إعداد مفتاح API";
    }
  } catch {
    label.textContent = "تعذر الاتصال بالخادم";
  }
}

async function submitMessage(message) {
  addMessage("user", message);
  input.value = "";
  input.style.height = "auto";
  send.disabled = true;
  const pending = addMessage("assistant", "بفكر في رد مناسب…");
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "حصل خطأ غير متوقع.");
    pending.textContent = data.answer;
  } catch (error) {
    pending.classList.add("error");
    pending.textContent = error.message || "تعذر إرسال الرسالة.";
  } finally {
    send.disabled = false;
    input.focus();
    pending.scrollIntoView({ behavior: "smooth", block: "end" });
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (message && !send.disabled) submitMessage(message);
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

document.querySelectorAll("[data-prompt]").forEach(button => {
  button.addEventListener("click", () => {
    input.value = button.dataset.prompt;
    form.requestSubmit();
  });
});

$("#new-chat").addEventListener("click", () => {
  sessionId = crypto.randomUUID().replaceAll("-", "");
  localStorage.setItem(sessionKey, sessionId);
  conversation.replaceChildren();
  const panel = document.createElement("div");
  panel.className = "welcome";
  panel.innerHTML = '<div class="welcome-icon">✦</div><p class="eyebrow">محادثة جديدة</p><h1>Instinct <span>AI</span></h1><p class="welcome-copy">ابدأ بسؤالك أو اكتب اللي محتاج مساعدة فيه.</p>';
  conversation.appendChild(panel);
  input.focus();
});

$("#menu-toggle").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
document.addEventListener("click", (event) => {
  if (event.target.closest(".sidebar") || event.target.closest("#menu-toggle")) return;
  $(".sidebar").classList.remove("open");
});

checkHealth();