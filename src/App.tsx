import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { RadarCanvas } from './RadarCanvas';
import { fetchComplaints, fetchComplaintsForDate, getComplaintColor, getTopComplaintTypes } from './complaints';
import type { Complaint } from './complaints';
import './App.css';

const MAX_FEED = 50;
const DOT_LIFETIME_MS = 10 * 60 * 1000; // 10 minutes visible
const SPEEDS = [1, 2, 4, 8, 16];

export default function App() {
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [topTypes, setTopTypes] = useState<string[]>([]);
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());
  const [feed, setFeed] = useState<Complaint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Replay clock state
  const [replayTime, setReplayTime] = useState<number>(0); // ms timestamp in "yesterday"
  const [playing, setPlaying] = useState(true);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [dataDate, setDataDate] = useState<string>(''); // "MAR 5" display string

  // Refs for the animation tick
  const playingRef = useRef(playing);
  const speedRef = useRef(SPEEDS[0]);
  const replayRef = useRef(0);
  const lastTickRef = useRef(0);

  playingRef.current = playing;
  speedRef.current = SPEEDS[speedIdx];

  const [selectedDate, setSelectedDate] = useState(''); // YYYY-MM-DD

  function initializeData(data: Complaint[], dateStr: string) {
    const types = getTopComplaintTypes(data, 16);
    setComplaints(data);
    setTopTypes(types);
    setActiveTypes(new Set(types));
    setFeed([]);

    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const d = new Date(dateStr + 'T12:00:00');
    setDataDate(`${months[d.getMonth()]} ${d.getDate()}`);
    setSelectedDate(dateStr);

    // Initialize replay to current NYC time-of-day mapped to the data date
    const nycNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const nycMidnight = new Date(nycNow.getFullYear(), nycNow.getMonth(), nycNow.getDate()).getTime();
    const nycTimeOfDay = nycNow.getTime() - nycMidnight;
    const dataStart = new Date(dateStr + 'T00:00:00').getTime();
    const startReplay = dataStart + nycTimeOfDay;
    setReplayTime(startReplay);
    replayRef.current = startReplay;
    pingedRef.current.clear();
  }

  const pingedRef = useRef<Set<string>>(new Set());

  // Initial load
  useEffect(() => {
    async function load() {
      try {
        const { data, date } = await fetchComplaints();
        if (data.length === 0) {
          setError('No 311 data available');
          setLoading(false);
          return;
        }
        initializeData(data, date);
      } catch (e) {
        setError('Failed to load 311 data');
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // Switch date
  const switchDate = async (offset: number) => {
    if (!selectedDate) return;
    const current = new Date(selectedDate + 'T12:00:00');
    current.setDate(current.getDate() + offset);
    const newDate = current.toISOString().split('T')[0];
    setLoading(true);
    setError(null);
    try {
      const data = await fetchComplaintsForDate(newDate);
      if (data.length === 0) {
        setError(`No data for ${newDate}`);
      } else {
        initializeData(data, newDate);
      }
    } catch (e) {
      setError('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  // Replay clock tick — advance ref every frame, update React state every 500ms for display
  useEffect(() => {
    let raf: number;
    let lastDisplayUpdate = 0;
    function tick(ts: number) {
      if (lastTickRef.current && playingRef.current) {
        const dt = Math.min(ts - lastTickRef.current, 50);
        replayRef.current += dt * speedRef.current;
      }
      lastTickRef.current = ts;
      // Update React display state every 500ms (not every frame)
      if (ts - lastDisplayUpdate > 500) {
        lastDisplayUpdate = ts;
        setReplayTime(replayRef.current);
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Filter by type only — RadarCanvas handles all time-based visibility
  // Memoized so reference only changes when complaints or activeTypes change, NOT on every replayTime tick
  const filteredComplaints = useMemo(() =>
    complaints.filter(c => activeTypes.has(c.complaint_type)),
    [complaints, activeTypes]
  );

  // Queue pings and drip them into the feed one at a time
  const pingQueueRef = useRef<Complaint[]>([]);

  const handlePing = useCallback((complaint: Complaint) => {
    pingQueueRef.current.push(complaint);
  }, []);

  // Drip feed: add one item every 150ms for smooth scrolling
  useEffect(() => {
    const interval = setInterval(() => {
      if (pingQueueRef.current.length === 0) return;
      const next = pingQueueRef.current.shift()!;
      setFeed(prev => {
        if (prev.length > 0 && prev[0].unique_key === next.unique_key) return prev;
        return [next, ...prev].slice(0, MAX_FEED);
      });
    }, 150);
    return () => clearInterval(interval);
  }, []);

  const toggleType = (type: string) => {
    setActiveTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  };

  const toggleAll = () => {
    if (activeTypes.size === topTypes.length) setActiveTypes(new Set());
    else setActiveTypes(new Set(topTypes));
  };

  const cycleSpeed = () => {
    setSpeedIdx(prev => (prev + 1) % SPEEDS.length);
  };

  const skipBack = () => {
    replayRef.current -= 15 * 60 * 1000; // -15 min
    setReplayTime(replayRef.current);
    setFeed([]);
  };

  const skipForward = () => {
    replayRef.current += 15 * 60 * 1000; // +15 min
    setReplayTime(replayRef.current);
  };

  // Format replay time as HH:MM:SS in ET
  const replayDate = new Date(replayTime);
  const timeStr = replayDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'America/New_York' });

  return (
    <div className="app">
      {/* ── Left sidebar ── */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="title">NYC 311 RADAR</div>
          <div className="subtitle">COMPLAINT SCANNER</div>
          <div className="replay-info">
            <div className="replay-date-row">
              <button className="date-nav" onClick={() => switchDate(-1)}>◀</button>
              <span className="replay-date">REPLAY: {dataDate}</span>
              <button className="date-nav" onClick={() => switchDate(1)}>▶</button>
            </div>
            <div className="replay-time">{timeStr} ET</div>
            <div className="replay-delay">24H DELAY</div>
          </div>
          <div className="meta">
            {loading ? 'LOADING…' : `${filteredComplaints.length.toLocaleString()} SIGNALS`}
          </div>
        </div>

        {/* Playback controls */}
        <div className="playback">
          <button className="pb-btn" onClick={skipBack} title="Back 15 min">⏪</button>
          <button className="pb-btn pb-play" onClick={() => setPlaying(!playing)}>
            {playing ? '⏸' : '▶'}
          </button>
          <button className="pb-btn" onClick={skipForward} title="Forward 15 min">⏩</button>
          <button className="pb-btn pb-speed" onClick={cycleSpeed}>
            {SPEEDS[speedIdx]}×
          </button>
        </div>

        <div className="filter-section">
          <div className="filter-header">
            <span className="filter-label">COMPLAINT TYPE</span>
            <button className="filter-all" onClick={toggleAll}>
              {activeTypes.size === topTypes.length ? 'NONE' : 'ALL'}
            </button>
          </div>
          <div className="filter-list">
            {topTypes.map(type => (
              <button
                key={type}
                className={`filter-chip ${activeTypes.has(type) ? 'active' : ''}`}
                onClick={() => toggleType(type)}
                style={{ '--chip-color': getComplaintColor(type) } as React.CSSProperties}
              >
                <span className="chip-dot" style={{ background: getComplaintColor(type) }} />
                <span className="chip-label">{type}</span>
              </button>
            ))}
          </div>
        </div>

        {error && <div className="error">{error}</div>}
      </div>

      {/* ── Radar ── */}
      <div className="radar-wrap">
        <RadarCanvas
          complaints={filteredComplaints}
          activeTypes={activeTypes}
          replayTime={replayTime}
          dotLifetime={DOT_LIFETIME_MS}
          onPing={handlePing}
        />
      </div>

      {/* ── Right feed ── */}
      <div className="feed-panel">
        <div className="feed-header">{dataDate || '—'} FEED</div>
        <div className="feed-list">
          {feed.length === 0 && (
            <div className="feed-empty">Waiting for signals…</div>
          )}
          {feed.map((c) => (
            <div key={c.unique_key} className="feed-item" style={{ '--item-color': getComplaintColor(c.complaint_type) } as React.CSSProperties}>
              <span className="feed-dot" style={{ background: getComplaintColor(c.complaint_type) }} />
              <div className="feed-content">
                <div className="feed-type">{c.complaint_type}</div>
                {c.descriptor && <div className="feed-desc">{c.descriptor}</div>}
                <div className="feed-meta">
                  {c.borough} · {new Date(c.created_date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
