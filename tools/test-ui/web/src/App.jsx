import { useEffect, useMemo, useState } from 'react';

const RESYNC_MS = 3000;

const prettyDate = (value) => {
  if (!value) return '-';
  return new Date(value).toLocaleString();
};

const postJson = async (url, body) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }
  return response.json();
};

export default function App() {
  const [runs, setRuns] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedRun, setSelectedRun] = useState(null);
  const [loading, setLoading] = useState(false);
  const [targetOrg, setTargetOrg] = useState('devorg-scratch-1d');
  const [devHubAlias, setDevHubAlias] = useState('DevOrg');
  const [scratchDurationDays, setScratchDurationDays] = useState('1');
  const [keepOrg, setKeepOrg] = useState(false);
  const [showOrgForm, setShowOrgForm] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [live, setLive] = useState(false);
  const [error, setError] = useState('');

  const selectedSummary = useMemo(() => (selectedId ? runs.find((run) => run.id === selectedId) ?? null : null), [runs, selectedId]);
  const displayRun = selectedRun ? { ...selectedRun, ...selectedSummary } : null;

  const fetchRuns = async () => {
    const response = await fetch('/api/runs');
    const payload = await response.json();
    setRuns(payload);
    if (!selectedId && payload.length > 0) {
      setSelectedId(payload[0].id);
    }
  };

  const fetchSelected = async (id) => {
    if (!id) {
      setSelectedRun(null);
      return;
    }
    const response = await fetch(`/api/runs/${id}`);
    if (!response.ok) {
      setSelectedRun(null);
      return;
    }
    const payload = await response.json();
    setSelectedRun(payload);
  };

  useEffect(() => {
    fetchRuns().catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    fetchSelected(selectedId).catch((err) => setError(err.message));
  }, [selectedId]);

  useEffect(() => {
    const applyRunSummary = (summary) => {
      setRuns((prev) => {
        const filtered = prev.filter((run) => run.id !== summary.id);
        return [summary, ...filtered].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
      });
    };

    const source = new EventSource('/api/events');
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === 'snapshot') {
          setRuns(payload.runs ?? []);
          setSelectedId((current) => current ?? payload.runs?.[0]?.id ?? null);
          return;
        }

        if (payload.type === 'created' || payload.type === 'updated') {
          if (payload.run) {
            applyRunSummary(payload.run);
            setSelectedRun((prev) =>
              prev && prev.id === payload.run.id
                ? {
                    ...prev,
                    ...payload.run,
                  }
                : prev
            );
          }
          return;
        }

        if (payload.type === 'log') {
          setSelectedRun((prev) =>
            prev && prev.id === payload.runId ? { ...prev, logs: `${prev.logs ?? ''}${payload.chunk ?? ''}` } : prev
          );
        }
      } catch {
        // no-op
      }
    };

    return () => {
      source.close();
      setLive(false);
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      fetchRuns().catch(() => {});
      if (selectedId) {
        fetchSelected(selectedId).catch(() => {});
      }
    }, RESYNC_MS);
    return () => clearInterval(timer);
  }, [selectedId]);

  const runLocal = async () => {
    setLoading(true);
    setError('');
    try {
      const created = await postJson('/api/runs', { suite: 'e2e-local' });
      setSelectedId(created.id);
      await fetchRuns();
      await fetchSelected(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const runOrg = async () => {
    setLoading(true);
    setError('');
    try {
      const created = await postJson('/api/runs', {
        suite: 'e2e-org',
        targetOrg: targetOrg.trim() || undefined,
        devHubAlias: devHubAlias.trim() || undefined,
        scratchDurationDays: scratchDurationDays.trim() || undefined,
        keepOrg,
      });
      setSelectedId(created.id);
      await fetchRuns();
      await fetchSelected(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const cancelSelectedRun = async () => {
    if (!selectedRun || selectedRun.status !== 'running') return;
    setCanceling(true);
    setError('');
    try {
      await postJson(`/api/runs/${selectedRun.id}/cancel`, {});
      await fetchRuns();
      await fetchSelected(selectedRun.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCanceling(false);
    }
  };

  return (
    <div className="layout">
      <header className="header">
        <h1>sf-df test runner</h1>
        <p>Piloter les tests e2e du plugin et lire les logs d'execution.</p>
        <span className={`live-badge ${live ? 'online' : 'offline'}`}>{live ? 'Live' : 'Reconnect...'}</span>
      </header>

      <section className="controls">
        <div className="launch-grid">
          <article className="launch-card">
            <h2>Run local</h2>
            <p>Execution rapide sans configuration d'org.</p>
            <button disabled={loading} onClick={runLocal}>
              {loading ? 'Lancement...' : 'Lancer e2e-local'}
            </button>
          </article>

          <article className="launch-card org-card">
            <h2>Run org</h2>
            <p>Utilise une org cible et des options de scratch org.</p>
            <button type="button" className="ghost-btn" onClick={() => setShowOrgForm((v) => !v)}>
              {showOrgForm ? 'Masquer les parametres' : 'Configurer les parametres'}
            </button>
            {showOrgForm ? (
              <div className="form-grid">
                <label>
                  Target org
                  <input value={targetOrg} onChange={(e) => setTargetOrg(e.target.value)} placeholder="devorg-scratch-1d" />
                </label>
                <label>
                  Dev Hub alias
                  <input value={devHubAlias} onChange={(e) => setDevHubAlias(e.target.value)} placeholder="DevOrg" />
                </label>
                <label>
                  Scratch days
                  <input
                    value={scratchDurationDays}
                    onChange={(e) => setScratchDurationDays(e.target.value)}
                    placeholder="1"
                  />
                </label>
                <label className="checkbox">
                  <input type="checkbox" checked={keepOrg} onChange={(e) => setKeepOrg(e.target.checked)} />
                  Keep org after run
                </label>
              </div>
            ) : null}
            <button disabled={loading} onClick={runOrg}>
              {loading ? 'Lancement...' : 'Lancer e2e-org'}
            </button>
          </article>
        </div>

        {error ? <p className="error">{error}</p> : null}
      </section>

      <main className="main">
        <aside className="runs">
          <h2>Runs</h2>
          <ul>
            {runs.map((run) => (
              <li key={run.id}>
                <button
                  className={`run-item ${selectedId === run.id ? 'selected' : ''}`}
                  onClick={() => {
                    setSelectedId(run.id);
                    fetchSelected(run.id).catch(() => {});
                  }}
                >
                  <span>{run.suite}</span>
                  <span className={`status ${run.status}`}>{run.status}</span>
                  <small>{prettyDate(run.startedAt)}</small>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="details">
          <h2>Details</h2>
          {displayRun ? (
            <>
              <div className="meta">
                <span>ID: {displayRun.id}</span>
                <span>Status: {displayRun.status}</span>
                {displayRun.status === 'running' ? <span className="running-inline">Run en cours...</span> : <span />}
                <span>Started: {prettyDate(displayRun.startedAt)}</span>
                <span>Ended: {prettyDate(displayRun.endedAt)}</span>
                <span>Exit: {String(displayRun.exitCode)}</span>
              </div>
              {displayRun.status === 'running' ? (
                <div className="actions">
                  <button type="button" className="danger-btn" disabled={canceling} onClick={cancelSelectedRun}>
                    {canceling ? 'Annulation...' : 'Annuler ce run'}
                  </button>
                </div>
              ) : null}
              <pre>{displayRun.logs || '(no logs yet)'}</pre>
            </>
          ) : (
            <p>Aucun run selectionne.</p>
          )}
        </section>
      </main>
    </div>
  );
}
