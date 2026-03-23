const STORAGE_KEYS = {
  templates: "pixelq.templates",
  popupDraft: "pixelq.popupDraft",
  quickDraftLegacy: "pixelq.quickDraft",
};

async function getStorage(keys) {
  return chrome.storage.local.get(keys);
}

async function setStorage(values) {
  return chrome.storage.local.set(values);
}

export async function loadTemplates() {
  const data = await getStorage([STORAGE_KEYS.templates]);
  return Array.isArray(data[STORAGE_KEYS.templates]) ? data[STORAGE_KEYS.templates] : [];
}

export async function saveTemplates(templates) {
  return setStorage({ [STORAGE_KEYS.templates]: templates });
}

export async function loadPopupDraft() {
  const data = await getStorage([STORAGE_KEYS.popupDraft, STORAGE_KEYS.quickDraftLegacy]);
  const popupDraft = data[STORAGE_KEYS.popupDraft];
  if (popupDraft && typeof popupDraft === "object") {
    return popupDraft;
  }

  const legacyRows = Array.isArray(data[STORAGE_KEYS.quickDraftLegacy]) ? data[STORAGE_KEYS.quickDraftLegacy] : [];
  const firstRow = legacyRows[0] || {};
  return {
    quick: {
      prompt: typeof firstRow.prompt === "string" ? firstRow.prompt : "",
      project: typeof firstRow.project === "string" ? firstRow.project : "",
      templateId: "",
      values: {},
    },
    batch: {
      project: "",
      templateId: "",
      lines: legacyRows
        .map((row) => (typeof row.prompt === "string" ? row.prompt.trim() : ""))
        .filter(Boolean)
        .join("\n"),
      csvFileName: "",
      csvHeaders: [],
      csvRows: [],
    },
  };
}

export async function savePopupDraft(draft) {
  return setStorage({ [STORAGE_KEYS.popupDraft]: draft });
}

export async function loadQuickDraft() {
  const draft = await loadPopupDraft();
  return Array.isArray(draft?.quickRows) ? draft.quickRows : [];
}

export async function saveQuickDraft(rows) {
  const draft = await loadPopupDraft();
  return savePopupDraft({ ...draft, quickRows: rows });
}
