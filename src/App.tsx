import { useState, useEffect, useRef, useCallback } from 'react';
import { RadarCanvas } from './RadarCanvas';
import { fetchComplaints, getComplaintColor, getTopComplaintTypes } from './complaints';
import type { Complaint } from './complaints';
import './App.css';

const MAX_FEED = 40;

export default function App() {
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [topTypes, setTopTypes] = useState<string[]>([]);
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());
  const [feed, setFeed] = useState<Complaint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sweepAngleRef = useRef<number>(-Math.PI / 2);

  useEffect(() => {
    async function load() {
      try {
        const data = await fetchComplaints();
        const types = getTopComplaintTypes(data, 16);
        setComplaints(data);
        setTopTypes(types);
        setActiveTypes(new Set(types));
      } catch (e) {
        setError('Failed to load 311 data');
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const handlePing = useCallback((complaint: Complaint) => {
    setFeed(prev => [complaint, ...prev].slice(0, MAX_FEED));
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

  const filteredComplaints = complaints.filter(c => activeTypes.has(c.complaint_type));

  return (
    <div className="app">
      {/* ── Left sidebar ── */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="title">NYC 311 RADAR</div>
          <div className="subtitle">LIVE COMPLAINT SCANNER</div>
          <div className="meta">
            {loading ? 'LOADING…' : `${filteredComplaints.length.toLocaleString()} SIGNALS · 24H`}
          </div>
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
          onPing={handlePing}
          sweepAngleRef={sweepAngleRef}
        />
      </div>

      {/* ── Right feed ── */}
      <div className="feed-panel">
        <div className="feed-header">LIVE FEED</div>
        <div className="feed-list">
          {feed.length === 0 && (
            <div className="feed-empty">Waiting for signals…</div>
          )}
          {feed.map((c, i) => (
            <div key={`${c.unique_key}-${i}`} className="feed-item" style={{ '--item-color': getComplaintColor(c.complaint_type) } as React.CSSProperties}>
              <span className="feed-dot" style={{ background: getComplaintColor(c.complaint_type) }} />
              <div className="feed-content">
                <div className="feed-type">{c.complaint_type}</div>
                {c.descriptor && <div className="feed-desc">{c.descriptor}</div>}
                <div className="feed-meta">{c.borough} · {new Date(c.created_date).toLocaleTimeString()}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
