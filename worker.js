// Works out the board from the plan off the page's main thread, so dragging and playback stay smooth.
importScripts("derive.js");
onmessage = (e) => {
  const { seq, plan } = e.data;
  try {
    const r = self.PlanDerive.derive(plan);
    postMessage({ seq, data: r.data, warnings: r.warnings, checks: r.checks });
  } catch (err) {
    postMessage({ seq, error: String((err && err.stack) || err) });
  }
};
