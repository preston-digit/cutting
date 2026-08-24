import { useEffect, useMemo, useRef, useState } from "react";
import {
  getWorkOrder,
  scanSerial,
  searchInventory,
  searchBins,
  getDefaultBin,
  completeWorkOrder,
  commitCut,
  getAvailableMaterial,
} from "./api.js";
import BarcodeScannerModal from "./BarcodeScannerModal.jsx";

const OPERATOR_STORAGE_KEY = "cutting.operatorName";
// Mirrors backend/src/features/cutting/digitOps.js's looksLikeScancode/sanitizeScanValue —
// used here only to decide which resolution path to take before calling the API.
const SCANCODE_PATTERN = /^(mi|rcv|splt|job)_/;
function sanitizeScanValue(value) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f]/g, "").trim();
}
const DIGIT_APP_BASE_URL = "https://app.digit-software.com"; // opened client-side; see SCHEMA_NOTES.md

const COMMIT_STEP_LABELS = {
  splitWorkingPiece: "Split working piece from source label",
  writeWorkingPieceDimensions: "Write dimensions on working piece",
  splitRemnant: "Split side remnant",
  writeRemnantDimensions: "Write dimensions on remnant",
  writeSourceDimensions: "Update source label's remaining dimensions",
  pickWorkingPiece: "Pick working piece into the manufacturing order",
  startWorkOrder: "Start work order",
};

function StatusPill({ status }) {
  if (status === "IN_PROGRESS") return <span className="pill pill--blue">In Progress</span>;
  if (status === "COMPLETED") return <span className="pill pill--green">Completed</span>;
  return <span className="pill pill--neutral">Not Started</span>;
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn btn--secondary"
      style={{ padding: "2px 8px", fontSize: "var(--fs-sm)" }}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function ChecklistIcon({ status }) {
  const symbol = { pending: "", running: "…", ok: "✓", error: "!", skipped: "–" }[status] || "";
  return <span className={`checklist-icon checklist-icon--${status}`}>{symbol}</span>;
}

export default function CutScreen({ nav, workOrderId }) {
  const [wo, setWo] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [operatorName, setOperatorName] = useState(() => localStorage.getItem(OPERATOR_STORAGE_KEY) || "");

  // --- Scan / search state --------------------------------------------------
  const [scanInput, setScanInput] = useState("");
  const [scanError, setScanError] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [source, setSource] = useState(null);
  const [searchResults, setSearchResults] = useState(null);
  const [bomOverride, setBomOverride] = useState(false);
  const [areaMismatchAck, setAreaMismatchAck] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const scanInputRef = useRef(null);
  const cutLengthInputRef = useRef(null);
  const commitButtonRef = useRef(null);

  // --- Cut entry state -------------------------------------------------------
  const [cutWidth, setCutWidth] = useState("");
  const [cutLength, setCutLength] = useState("");
  const [remnantBin, setRemnantBin] = useState(null); // { id, name }
  const [binSearchResults, setBinSearchResults] = useState([]);
  const [binsError, setBinsError] = useState(null);
  const [cutNotes, setCutNotes] = useState("");

  // --- Available material (BOM component stock, sorted remnant-first) ------
  const [availableMaterial, setAvailableMaterial] = useState(null);
  const [availableMaterialError, setAvailableMaterialError] = useState(null);

  // --- Commit state -----------------------------------------------------------
  const [committing, setCommitting] = useState(false);
  const [steps, setSteps] = useState([]);
  const [commitSummary, setCommitSummary] = useState(null);
  const [commitError, setCommitError] = useState(null);

  useEffect(() => {
    localStorage.setItem(OPERATOR_STORAGE_KEY, operatorName);
  }, [operatorName]);

  useEffect(() => {
    let cancelled = false;
    getWorkOrder(workOrderId)
      .then((data) => !cancelled && setWo(data))
      .catch((err) => !cancelled && setLoadError(err.message));
    return () => {
      cancelled = true;
    };
  }, [workOrderId]);

  // NOTE: an earlier ref-based guard here (meant to dedupe React 18
  // StrictMode's dev-only double-invoke of effects) set the ref to "done" on
  // the very first invocation, before any data had arrived — so the second
  // (real) invocation skipped fetching entirely and the first invocation's
  // own result was discarded by its own cleanup's `cancelled` flag. Net
  // effect: the bin list never populated. A plain cancelled-flag effect (the
  // standard React data-fetching idiom) fixes it — an extra harmless GET in
  // dev is a fine price for the fetch actually running. REMNANT_BIN_NAME is
  // a convenience default only: if it doesn't resolve to a real bin (common
  // — it's an env var guess, not guaranteed to exist in this org), that's
  // not an error, the operator just picks one from the full list below.
  useEffect(() => {
    let cancelled = false;
    searchBins("")
      .then((list) => !cancelled && setBinSearchResults(list))
      .catch((err) => !cancelled && setBinsError(err.message));
    getDefaultBin()
      .then((bin) => !cancelled && setRemnantBin(bin))
      .catch(() => {
        /* no default configured for this org, or it doesn't match a real bin — leave unselected */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    scanInputRef.current?.focus();
  }, []);

  // Refetches whenever the work order reloads (incl. after each commit,
  // since a commit consumes stock) or the operator's entered cut dimensions
  // change (debounced — sufficiency/waste sort only sharpens once dimensions
  // are known, but the list is useful even before that).
  useEffect(() => {
    let cancelled = false;
    const w = Number(cutWidth);
    const l = Number(cutLength);
    const timer = setTimeout(() => {
      getAvailableMaterial(workOrderId, w > 0 ? w : undefined, l > 0 ? l : undefined)
        .then((list) => !cancelled && setAvailableMaterial(list))
        .catch((err) => !cancelled && setAvailableMaterialError(err.message));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [workOrderId, wo, cutWidth, cutLength]);

  // Shared by the typed/USB-wedge path (form submit) and the camera path.
  // A camera decode, or any typed value shaped like a Digit scancode, must
  // resolve by EXACT scancode match only — never fall through to a fuzzy
  // search, which would silently hand the operator the wrong roll. A typed
  // value that isn't scancode-shaped uses the manual search path instead:
  // an exact bare-number/"Label #9" match may auto-apply (it's exact, not
  // fuzzy); anything else always shows a pick list, even for one result.
  async function resolveScan(value, { fromCamera = false } = {}) {
    const sanitized = sanitizeScanValue(value);
    if (!sanitized) return;
    setScanning(true);
    setScanError(null);
    setSearchResults(null);
    try {
      if (fromCamera || SCANCODE_PATTERN.test(sanitized)) {
        try {
          const result = await scanSerial(sanitized, workOrderId);
          applySource(result);
        } catch (err) {
          setScanError(`No label found for scancode "${sanitized}"`);
        }
        return;
      }

      const { matchType, results } = await searchInventory(sanitized, workOrderId);
      if (results.length === 0) {
        setScanError(`No label found for "${sanitized}"`);
      } else if (matchType === "exact_label_number" && results.length === 1) {
        applySource(results[0]);
      } else {
        setSearchResults(results);
      }
    } catch (err) {
      setScanError(err.message);
    } finally {
      setScanning(false);
    }
  }

  // Operator's hands are usually busy holding the roll — a full cut should
  // be doable via Enter alone: width → length → commit button.
  function focusOnEnter(nextRef) {
    return (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      nextRef.current?.focus();
    };
  }

  function handleScanSubmit(e) {
    e.preventDefault();
    resolveScan(scanInput);
  }

  function handleCameraDetected(rawValue) {
    setScannerOpen(false);
    resolveScan(rawValue, { fromCamera: true });
  }

  function applySource(inv) {
    setSource(inv);
    setBomOverride(false);
    setAreaMismatchAck(false);
    setSearchResults(null);
    setScanInput("");
  }

  const bomMismatch = useMemo(() => {
    if (!source || !wo?.bomComponents?.length) return false;
    return !wo.bomComponents.some((c) => c.itemId === source.itemId);
  }, [source, wo]);

  const readyToEnterCut =
    source && (!bomMismatch || bomOverride) && (!source.areaMismatch?.outOfSync || areaMismatchAck);

  // --- Cut math (mirrors backend/src/features/cutting/routes.js) ------------
  const cut = useMemo(() => {
    const w = Number(cutWidth);
    const l = Number(cutLength);
    if (!source || !w || !l || w <= 0 || l <= 0) return null;
    const sourceWidth = source.rollWidth;
    const sourceLength = source.rollLength;
    const cutArea = w * l;
    const hasSideRemnant = sourceWidth != null && w < sourceWidth;
    const remnantWidth = hasSideRemnant ? sourceWidth - w : null;
    const remnantLength = hasSideRemnant ? l : null;
    const remnantArea = hasSideRemnant ? remnantWidth * remnantLength : 0;
    const sourceLengthAfter = sourceLength != null ? sourceLength - l : null;
    const exceedsSource = sourceWidth != null && w > sourceWidth;
    const exceedsLength = sourceLength != null && l > sourceLength;
    return {
      cutWidth: w,
      cutLength: l,
      cutArea,
      hasSideRemnant,
      remnantWidth,
      remnantLength,
      remnantArea,
      sourceWidthAfter: sourceWidth,
      sourceLengthAfter,
      exceedsSource,
      exceedsLength,
    };
  }, [cutWidth, cutLength, source]);

  // Reset back to the scan step for the next piece — the operator should be
  // able to cut a whole work order in uninterrupted scan-measure-commit
  // cycles without the screen dead-ending on a "committed" panel each time.
  function resetForNextPiece() {
    setSource(null);
    setSearchResults(null);
    setCutWidth("");
    setCutLength("");
    setSteps([]);
    setCommitSummary(null);
    setCommitError(null);
    setScanInput("");
    setScanError(null);
    setCutNotes("");
    scanInputRef.current?.focus();
  }

  async function handleCommit() {
    if (!cut || !source) return;
    setCommitting(true);
    setSteps([]);
    setCommitSummary(null);
    setCommitError(null);
    const plannedKeys = ["splitWorkingPiece", "writeWorkingPieceDimensions"];
    if (cut.hasSideRemnant) plannedKeys.push("splitRemnant", "writeRemnantDimensions");
    plannedKeys.push("writeSourceDimensions", "pickWorkingPiece", "startWorkOrder");
    setSteps(plannedKeys.map((key) => ({ key, label: COMMIT_STEP_LABELS[key], status: "pending" })));

    let summary = null;
    try {
      await commitCut(
        workOrderId,
        {
          sourceInventoryId: source.id,
          cutWidth: cut.cutWidth,
          cutLength: cut.cutLength,
          remnantBinId: cut.hasSideRemnant ? remnantBin?.id : undefined,
          operatorName,
          notes: cutNotes.trim() || undefined,
        },
        (event) => {
          if (event.key === "summary") {
            summary = event;
            setCommitSummary(event);
            return;
          }
          if (event.key === "fatal") {
            setCommitError(event.error);
            return;
          }
          setSteps((prev) => prev.map((s) => (s.key === event.key ? { ...s, ...event } : s)));
        }
      );

      if (summary?.status === "completed") {
        const fresh = await getWorkOrder(workOrderId);
        setWo(fresh);
        if ((fresh.cutCount || 0) < fresh.targetQuantity) {
          // Brief success confirmation, then clear back to the scan state
          // automatically — more pieces remain on this work order.
          setTimeout(resetForNextPiece, 2000);
        }
      }
    } catch (err) {
      setCommitError(err.message);
    } finally {
      setCommitting(false);
    }
  }

  async function handleCompleteCut() {
    const cutCount = wo.cutCount || 0;
    if (cutCount < wo.targetQuantity) {
      const proceed = window.confirm(
        `Only ${cutCount} of ${wo.targetQuantity} pieces have been cut. Complete the work order early anyway?`
      );
      if (!proceed) return;
    }
    try {
      await completeWorkOrder(workOrderId, cutCount);
      const fresh = await getWorkOrder(workOrderId);
      setWo(fresh);
    } catch (err) {
      setCommitError(err.message);
    }
  }

  if (loadError) return <div className="checklist-error-box" style={{ margin: "var(--space-5)" }}>{loadError}</div>;
  if (!wo) return <div style={{ padding: "var(--space-5)" }} className="muted">Loading…</div>;

  const cutCount = wo.cutCount || 0;
  const progressPct = wo.targetQuantity ? Math.min(100, (cutCount / wo.targetQuantity) * 100) : 0;
  const committed = commitSummary?.status === "completed";

  // The split and its paired dimension write are separate checklist steps —
  // if the split succeeded but the write failed, say exactly what's now
  // wrong in Digit and what it should have been, so it can be fixed by hand.
  function repairMessage(step) {
    const splitStepKey =
      step.key === "writeWorkingPieceDimensions" ? "splitWorkingPiece" : step.key === "writeRemnantDimensions" ? "splitRemnant" : null;
    if (splitStepKey) {
      const splitStep = steps.find((s) => s.key === splitStepKey);
      const created = splitStep?.digit?.newInventory;
      if (created) {
        const intendedL = splitStepKey === "splitWorkingPiece" ? cut?.cutLength : cut?.remnantLength;
        const intendedW = splitStepKey === "splitWorkingPiece" ? cut?.cutWidth : cut?.remnantWidth;
        return `Label #${created.scanCodeNumber} (${created.scanCodeSerialNumber}) was created at ${created.quantityInStock} ft², but dimensions were NOT written — intended Roll Length=${intendedL}, Roll Width=${intendedW}. Needs manual repair in Digit.`;
      }
    }
    if (step.key === "writeSourceDimensions" && cut) {
      return `Source label #${source.labelNumber} (${source.scancode}) has the correct reduced quantity in Digit, but dimensions were NOT updated — intended Roll Length=${cut.sourceLengthAfter}, Roll Width=${cut.sourceWidthAfter}. Needs manual repair in Digit.`;
    }
    return `${step.error} Needs manual repair in Digit if a split already completed before this step.`;
  }

  return (
    <div style={{ padding: "var(--space-5)" }}>
      <div className="breadcrumb">
        <span className="link" onClick={() => nav("cutting.queue")}>Work orders</span>
        <span className="sep">›</span>
        <span>WO{wo.workOrderNumber}</span>
      </div>
      <div className="page-title-row">
        <h1 className="page-title">WO{wo.workOrderNumber}</h1>
        <StatusPill status={wo.status} />
      </div>
      <div className="page-subtitle">
        {wo.createdBy ? `Created by ${wo.createdBy}` : "Created"}
        {wo.createdOn ? ` on ${new Date(wo.createdOn).toLocaleDateString()}` : ""}
      </div>

      <div className="tab-row">
        <div className="tab tab--active">Cut to size</div>
      </div>

      <div className="two-col">
        <div className="card">
          <div className="section-label">Job details</div>
          <div className="kv-list" style={{ marginBottom: "var(--space-4)" }}>
            <div className="kv-row">
              <span className="kv-label">Work order</span>
              <span className="kv-value">WO{wo.workOrderNumber} <StatusPill status={wo.status} /></span>
            </div>
            <div className="kv-row">
              <span className="kv-label">Manufacturing order</span>
              <span className="kv-value">{wo.moNumber}</span>
            </div>
            <div className="kv-row">
              <span className="kv-label">Item</span>
              <span className="kv-value">{wo.itemName} ({wo.itemSku})</span>
            </div>
            <div className="kv-row">
              <span className="kv-label">Target quantity</span>
              <span className="kv-value mono">{wo.targetQuantity} ea</span>
            </div>
          </div>

          {wo.bomComponents?.length > 0 && (
            <div style={{ marginBottom: "var(--space-4)" }}>
              <div className="section-label" style={{ marginBottom: "var(--space-2)" }}>Materials required</div>
              <div className="card" style={{ padding: 0 }}>
                <div className="table-head-row">
                  <div className="col">Item</div>
                  <div className="col">Qty per unit</div>
                  <div className="col">Total required</div>
                </div>
                {wo.bomComponents.map((c) => (
                  <div key={c.itemId} className="row" style={{ cursor: "default" }}>
                    <div className="col">{c.itemName} <span className="muted">({c.itemSku})</span></div>
                    <div className="col mono">{c.quantityPerUnit ?? "—"}</div>
                    <div className="col mono">{c.totalRequired ?? "—"}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="kv-list" style={{ marginBottom: "var(--space-4)" }}>
            {wo.salesOrderNumber && (
              <div className="kv-row">
                <span className="kv-label">Sales order</span>
                <span className="kv-value">
                  {wo.salesOrderNumber}
                  {wo.customerName ? ` — ${wo.customerName}` : ""}
                </span>
              </div>
            )}
            {wo.shipByDate && (
              <div className="kv-row">
                <span className="kv-label">Ship by</span>
                <span className="kv-value">{new Date(wo.shipByDate).toLocaleDateString()}</span>
              </div>
            )}
          </div>

          {wo.moNotes && (
            <div className="warning-box" style={{ marginBottom: "var(--space-4)" }}>
              <strong>MO notes:</strong> {wo.moNotes}
            </div>
          )}

          {!committed && availableMaterial && availableMaterial.length > 0 && (
            <div style={{ marginBottom: "var(--space-4)" }}>
              <div className="section-label" style={{ marginBottom: "var(--space-2)" }}>
                Available material
                <span className="muted" style={{ fontWeight: 400 }}> — click a row to select it, or scan a roll directly</span>
              </div>
              <div className="card" style={{ padding: 0 }}>
                <div className="table-head-row">
                  <div className="col">Label</div>
                  <div className="col">Type</div>
                  <div className="col">Dimensions</div>
                  <div className="col">Owner</div>
                  <div className="col">Bin</div>
                </div>
                {availableMaterial.map((p) => (
                  <div key={p.id} className="row" onClick={() => applySource(p)}>
                    <div className="col">
                      Label #{p.labelNumber} <span className="muted mono">({p.quantityInStock} ft²)</span>
                    </div>
                    <div className="col">
                      <span className={`pill ${p.pieceType === "Remnant" ? "pill--purple" : "pill--neutral"}`}>
                        {p.pieceType === "Remnant" ? "Remnant" : p.pieceType || "Mill Roll"}
                      </span>
                    </div>
                    <div className="col mono">
                      {p.knownDims ? `${p.rollWidth} × ${p.rollLength} ft` : <span className="negative">unknown/out of sync</span>}
                    </div>
                    <div className="col">{p.owner ?? "—"}</div>
                    <div className="col">{p.binName}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {!committed && availableMaterialError && (
            <div className="checklist-error-box" style={{ marginBottom: "var(--space-4)" }}>
              Could not load available material: {availableMaterialError}
            </div>
          )}

          <div className="field">
            <label className="field-label">Operator</label>
            <input
              className="input"
              placeholder="Your name"
              value={operatorName}
              onChange={(e) => setOperatorName(e.target.value)}
              style={{ maxWidth: 240 }}
            />
          </div>

          {!committed && (
            <>
              <h2 className="section-label">Scan the source roll</h2>
              <form onSubmit={handleScanSubmit} style={{ display: "flex", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
                <input
                  ref={scanInputRef}
                  className="input"
                  style={{ flex: 1 }}
                  placeholder="Scan barcode or type Label # / item name"
                  value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  disabled={scanning}
                />
                <button className="btn btn--secondary" type="submit" disabled={scanning}>
                  {scanning ? "Looking up…" : "Find"}
                </button>
                <button
                  type="button"
                  className="btn btn--secondary"
                  title="Scan with camera"
                  aria-label="Scan with camera"
                  onClick={() => setScannerOpen(true)}
                  disabled={scanning}
                >
                  📷
                </button>
              </form>

              {scannerOpen && (
                <BarcodeScannerModal onDetected={handleCameraDetected} onClose={() => setScannerOpen(false)} />
              )}

              {scanError && <div className="checklist-error-box" style={{ marginBottom: "var(--space-3)" }}>{scanError}</div>}

              {searchResults && (
                <div className="card" style={{ marginBottom: "var(--space-3)" }}>
                  <div className="muted" style={{ marginBottom: "var(--space-2)" }}>Multiple matches — pick one:</div>
                  {searchResults.map((r) => (
                    <div key={r.id} className="row" onClick={() => applySource(r)}>
                      <div className="col">Label #{r.labelNumber} — {r.itemName}</div>
                      <div className="col mono">{r.quantityInStock} ft²</div>
                      <div className="col">{r.binName}</div>
                    </div>
                  ))}
                </div>
              )}

              {source && (
                <div className="card" style={{ marginBottom: "var(--space-4)" }}>
                  <div className="kv-list">
                    <div className="kv-row">
                      <span className="kv-label">Label #</span>
                      <span className="kv-value">{source.labelNumber}</span>
                    </div>
                    <div className="kv-row">
                      <span className="kv-label">Scancode</span>
                      <span className="kv-value mono" style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                        {source.scancode} <CopyButton text={source.scancode} />
                      </span>
                    </div>
                    <div className="kv-row">
                      <span className="kv-label">Item</span>
                      <span className="kv-value">{source.itemName}</span>
                    </div>
                    <div className="kv-row">
                      <span className="kv-label">Quantity in stock</span>
                      <span className="kv-value mono">{source.quantityInStock} ft²</span>
                    </div>
                    <div className="kv-row">
                      <span className="kv-label">Roll Length</span>
                      <span className="kv-value mono">{source.rollLength ?? "—"} ft</span>
                    </div>
                    <div className="kv-row">
                      <span className="kv-label">Roll Width</span>
                      <span className="kv-value mono">{source.rollWidth ?? "—"} ft</span>
                    </div>
                    <div className="kv-row">
                      <span className="kv-label">Owner</span>
                      <span className="kv-value">{source.owner ?? "—"}</span>
                    </div>
                    <div className="kv-row">
                      <span className="kv-label">Current bin</span>
                      <span className="kv-value">{source.binName}</span>
                    </div>
                  </div>

                  {bomMismatch && (
                    <div className="warning-box" style={{ marginTop: "var(--space-3)" }}>
                      This label's item ("{source.itemName}") doesn't match this MO's BOM component
                      ({wo.bomComponents.map((c) => c.itemName).join(", ")}).
                      <label style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)", alignItems: "center" }}>
                        <input type="checkbox" checked={bomOverride} onChange={(e) => setBomOverride(e.target.checked)} />
                        Override and use this label anyway
                      </label>
                    </div>
                  )}

                  {source.areaMismatch?.outOfSync && (
                    <div className="warning-box" style={{ marginTop: "var(--space-3)" }}>
                      This label's dimensions are out of sync with its area — likely split outside this
                      module. Quantity in stock is <span className="mono">{source.areaMismatch.quantityInStock} ft²</span>,
                      but Roll Length × Roll Width implies <span className="mono">{source.areaMismatch.impliedArea} ft²</span>.
                      <label style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)", alignItems: "center" }}>
                        <input type="checkbox" checked={areaMismatchAck} onChange={(e) => setAreaMismatchAck(e.target.checked)} />
                        I confirm the dimensions above and want to cut anyway
                      </label>
                    </div>
                  )}
                </div>
              )}

              {source && readyToEnterCut && (
                <>
                  <h2 className="section-label">Cut entry</h2>
                  <div style={{ display: "flex", gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Cut Width (ft)</label>
                      <input
                        className="input"
                        type="number"
                        min="0"
                        step="0.1"
                        value={cutWidth}
                        onChange={(e) => setCutWidth(e.target.value)}
                        onKeyDown={focusOnEnter(cutLengthInputRef)}
                        autoFocus
                      />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label className="field-label">Cut Length (ft)</label>
                      <input
                        ref={cutLengthInputRef}
                        className="input"
                        type="number"
                        min="0"
                        step="0.1"
                        value={cutLength}
                        onChange={(e) => setCutLength(e.target.value)}
                        onKeyDown={focusOnEnter(commitButtonRef)}
                      />
                    </div>
                  </div>

                  {cut && (cut.exceedsSource || cut.exceedsLength) && (
                    <div className="checklist-error-box" style={{ marginBottom: "var(--space-3)" }}>
                      Cut dimensions exceed the source roll ({source.rollWidth} × {source.rollLength} ft).
                    </div>
                  )}

                  {cut && !cut.exceedsSource && !cut.exceedsLength && (
                    <div className="card" style={{ marginBottom: "var(--space-4)" }}>
                      <div className="section-label" style={{ marginBottom: "var(--space-2)" }}>Summary</div>
                      <div style={{ marginBottom: "var(--space-2)" }}>
                        Consume <span className="mono">{cut.cutArea} ft²</span> from Label #{source.labelNumber}.
                      </div>
                      <div style={{ marginBottom: "var(--space-2)" }}>
                        Create piece <span className="mono">{cut.cutWidth} × {cut.cutLength} ft</span> (<span className="mono">{cut.cutArea} ft²</span>).
                      </div>
                      {cut.hasSideRemnant ? (
                        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-2)" }}>
                          <span>
                            Create remnant <span className="mono">{cut.remnantWidth} × {cut.remnantLength} ft</span> (<span className="mono">{cut.remnantArea} ft²</span>) →
                          </span>
                          <select
                            className="select"
                            value={remnantBin?.id || ""}
                            onChange={(e) => {
                              const chosen = binSearchResults.find((b) => b.id === e.target.value);
                              setRemnantBin(chosen || null);
                            }}
                          >
                            <option value="" disabled>Select a bin…</option>
                            {binSearchResults.map((b) => (
                              <option key={b.id} value={b.id}>{b.name}</option>
                            ))}
                          </select>
                        </div>
                      ) : (
                        <div className="muted" style={{ marginBottom: "var(--space-2)" }}>
                          Full-width crosscut — no side remnant. Source label continues at{" "}
                          <span className="mono">{cut.sourceWidthAfter} × {cut.sourceLengthAfter} ft</span>.
                        </div>
                      )}
                      {binsError && (
                        <div className="checklist-error-box" style={{ marginBottom: "var(--space-2)" }}>
                          Could not load bin list: {binsError}
                        </div>
                      )}
                      {cut.hasSideRemnant && !remnantBin && (
                        <div className="warning-box" style={{ marginBottom: "var(--space-2)" }}>Select a remnant bin</div>
                      )}

                      <div className="field">
                        <label className="field-label">Notes (optional) — a flaw, a mis-measure, an override reason</label>
                        <textarea
                          className="input"
                          rows={2}
                          value={cutNotes}
                          onChange={(e) => setCutNotes(e.target.value)}
                          placeholder="Anything unusual about this cut…"
                        />
                      </div>

                      <button
                        ref={commitButtonRef}
                        className="btn btn--primary btn--commit"
                        disabled={committing || (cut.hasSideRemnant && !remnantBin)}
                        onClick={handleCommit}
                        style={{ marginTop: "var(--space-3)" }}
                      >
                        {committing ? "Committing…" : "Commit cut"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {steps.length > 0 && (
            <div className="card" style={{ marginBottom: "var(--space-4)" }}>
              <div className="section-label">Commit checklist</div>
              <div className="checklist">
                {steps.map((s) => (
                  <div key={s.key} className="checklist-item">
                    <ChecklistIcon status={s.status} />
                    <div>
                      <div>{s.label}</div>
                      {s.detail && <div className="checklist-detail">{s.detail}</div>}
                      {s.status === "error" && <div className="checklist-error-box">{repairMessage(s)}</div>}
                    </div>
                  </div>
                ))}
              </div>
              {commitError && <div className="checklist-error-box" style={{ marginTop: "var(--space-3)" }}>{commitError}</div>}
            </div>
          )}

          {committed && (
            <div className="card">
              <div className="section-label">Cut committed</div>
              <div className="muted" style={{ marginBottom: "var(--space-3)" }}>
                Digit has no direct print API — labels are printed from Digit's own UI. Open the
                serialized inventory list below, find the label by scancode, and click{" "}
                <strong>Reprint label</strong>.
              </div>
              {[
                { title: "Working piece", info: commitSummary.workingPiece },
                { title: "Remnant", info: commitSummary.remnant },
              ]
                .filter((x) => x.info)
                .map((x) => (
                  <div key={x.title} className="kv-row" style={{ marginBottom: "var(--space-2)" }}>
                    <span className="kv-label">{x.title}</span>
                    <span className="kv-value mono" style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
                      Label #{x.info.labelNumber} — {x.info.scancode} <CopyButton text={x.info.scancode} />
                    </span>
                  </div>
                ))}
              <button
                className="btn btn--secondary"
                style={{ marginTop: "var(--space-3)" }}
                onClick={() => window.open(`${DIGIT_APP_BASE_URL}/operations/inventory/serialized`, "_blank")}
              >
                Open serialized inventory list ↗
              </button>
            </div>
          )}
        </div>

        <div className="card">
          <div className="sidebar-item-card">
            <div className="sidebar-item-icon">{(wo.itemName || "?").slice(0, 1).toUpperCase()}</div>
            <div>
              <div className="sidebar-item-name">{wo.itemName}</div>
              <div className="sidebar-item-sku">{wo.itemSku}</div>
            </div>
          </div>

          <div className="section-label">Current job</div>
          <div className="progress-bar-row">
            <div className="progress-bar-track">
              <div className="progress-bar-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="progress-bar-label">{cutCount} of {wo.targetQuantity} cut</div>
          </div>

          <button
            className="btn btn--primary"
            style={{ width: "100%", justifyContent: "center", marginBottom: "var(--space-4)" }}
            onClick={handleCompleteCut}
            disabled={wo.status === "COMPLETED" || cutCount === 0}
          >
            {wo.status === "COMPLETED" ? "Work order completed" : `Complete ${cutCount} of ${wo.targetQuantity}`}
          </button>

          <div className="kv-list">
            <div className="kv-row">
              <span className="kv-label">Location</span>
              <span className="kv-value">{wo.binName}</span>
            </div>
            <div className="kv-row">
              <span className="kv-label">Work center</span>
              <span className="kv-value">{wo.binName}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
