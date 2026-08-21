import { useEffect, useRef, useState } from "react";

// Code 128 is what Digit encodes on its labels; the rest cover the common
// 1D formats a warehouse might also carry printed goods in.
const SUPPORTED_FORMATS = ["code_128", "code_39", "codabar", "ean_13", "ean_8", "itf", "upc_a", "upc_e"];

function cameraRequiresSecureContext() {
  if (window.isSecureContext) return false;
  const host = location.hostname;
  return !(host === "localhost" || host === "127.0.0.1");
}

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.16);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.16);
    osc.onended = () => ctx.close();
  } catch {
    // Audio isn't available in every context (e.g. autoplay policies) — the
    // visual "Scanned" flash still confirms the read either way.
  }
}

/**
 * Full-screen camera scanner modal. Decodes with the native BarcodeDetector
 * API where available, falling back to @zxing/browser's
 * BrowserMultiFormatReader otherwise. Calls onDetected(rawValue) exactly
 * once on a successful decode; the caller feeds that value into the same
 * resolution path a typed/USB-wedge-scanned value uses.
 */
export default function BarcodeScannerModal({ onDetected, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const zxingControlsRef = useRef(null);
  const stoppedRef = useRef(false);
  const [status, setStatus] = useState("requesting"); // requesting | streaming | success | error
  const [errorMessage, setErrorMessage] = useState(null);

  // Latest callback in a ref, not an effect dependency — onDetected is a new
  // function identity on every parent render, and this effect must run
  // exactly once per modal open (it starts the camera), not on every
  // upstream re-render.
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;

  useEffect(() => {
    let cancelled = false;

    function stopStream() {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      zxingControlsRef.current?.stop();
      zxingControlsRef.current = null;
    }

    function handleDecoded(text) {
      if (stoppedRef.current) return;
      stoppedRef.current = true;
      setStatus("success");
      playBeep();
      stopStream();
      setTimeout(() => {
        if (!cancelled) onDetectedRef.current(text);
      }, 150); // brief success flash before the modal closes
    }

    async function runBarcodeDetectorLoop() {
      let detector;
      try {
        detector = new window.BarcodeDetector({ formats: SUPPORTED_FORMATS });
      } catch {
        return runZxingFallback();
      }
      const tick = async () => {
        if (cancelled || stoppedRef.current) return;
        try {
          const codes = await detector.detect(videoRef.current);
          if (codes.length) {
            handleDecoded(codes[0].rawValue);
            return;
          }
        } catch {
          // Transient per-frame decode error — keep trying.
        }
        if (!cancelled && !stoppedRef.current) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    async function runZxingFallback() {
      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      const { BarcodeFormat, DecodeHintType } = await import("@zxing/library");
      if (cancelled) return;
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.CODE_128,
        BarcodeFormat.CODE_39,
        BarcodeFormat.CODABAR,
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.ITF,
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
      ]);
      const reader = new BrowserMultiFormatReader(hints);
      if (cancelled || !streamRef.current) return;
      const controls = await reader.decodeFromStream(streamRef.current, videoRef.current, (result) => {
        if (result) handleDecoded(result.getText());
      });
      zxingControlsRef.current = controls;
    }

    async function start() {
      if (cameraRequiresSecureContext()) {
        setStatus("error");
        setErrorMessage("Camera access requires HTTPS (or localhost) — this connection isn't secure.");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("error");
        setErrorMessage("This browser doesn't support camera access.");
        return;
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        if (err.name === "NotAllowedError") setErrorMessage("Camera access denied — check this site's camera permission.");
        else if (err.name === "NotFoundError" || err.name === "OverconstrainedError") setErrorMessage("No camera found on this device.");
        else setErrorMessage(err.message || "Could not access the camera.");
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setStatus("streaming");

      if ("BarcodeDetector" in window) runBarcodeDetectorLoop();
      else runZxingFallback();
    }

    start();

    // Release the camera on unmount no matter how the modal goes away — a
    // camera left running on an all-day workstation is a real problem.
    return () => {
      cancelled = true;
      stoppedRef.current = true;
      stopStream();
    };
  }, []);

  function handleClose() {
    stoppedRef.current = true;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    zxingControlsRef.current?.stop();
    onClose();
  }

  return (
    <div className="scanner-modal-backdrop" onClick={handleClose}>
      <div className="scanner-modal" onClick={(e) => e.stopPropagation()}>
        <video ref={videoRef} autoPlay playsInline muted />
        <div className={`scanner-reticle${status === "success" ? " scanner-reticle--success" : ""}`} />
        <div className="scanner-status">
          {status === "requesting" && "Requesting camera access…"}
          {status === "streaming" && "Point the camera at a label barcode"}
          {status === "success" && "Scanned ✓"}
          {status === "error" && (errorMessage || "Camera error")}
        </div>
        <button className="btn btn--secondary scanner-close" onClick={handleClose}>Close</button>
      </div>
    </div>
  );
}
