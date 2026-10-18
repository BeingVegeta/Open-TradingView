import { B2B_DEFAULTS, B2B_FIELDS, type B2BField, type B2BSettings } from '@otv/shared';
import { useEffect } from 'react';
import { useWorkspace } from '../workspace/workspaceStore';

/** The script's inputs, grouped as in its settings dialog. Changes apply at once. */
export function B2BSettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useWorkspace((s) => s.b2b.settings);
  const setB2B = useWorkspace((s) => s.setB2B);
  const patch = (p: Partial<B2BSettings>) => setB2B({ settings: { ...settings, ...p } });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const input = (f: B2BField) => {
    if (f.kind === 'bool')
      return (
        <input
          type="checkbox"
          checked={settings[f.key]}
          onChange={(e) => patch({ [f.key]: e.target.checked })}
        />
      );
    if (f.kind === 'choice')
      return (
        <select
          value={settings[f.key]}
          onChange={(e) => patch({ [f.key]: e.target.value } as Partial<B2BSettings>)}
        >
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    return (
      <input
        type="number"
        min={f.min}
        max={f.max}
        step={f.step ?? (f.int ? 1 : 'any')}
        // Keyed by value so "reset" shows the new value; edits apply on change.
        key={settings[f.key]}
        defaultValue={settings[f.key]}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (e.target.value === '' || !Number.isFinite(v)) return;
          if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) return;
          patch({ [f.key]: f.int ? Math.round(v) : v });
        }}
      />
    );
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal b2b-settings"
        role="dialog"
        aria-label="N-B2B settings"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <strong>N-B2B v1.8 settings</strong>
          <span className="toolbar-spacer" />
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setB2B({ settings: B2B_DEFAULTS })}
          >
            Reset to the script&apos;s defaults
          </button>
          <button className="btn btn-sm" onClick={onClose}>
            Done
          </button>
        </header>
        <div className="modal-body">
          {B2B_FIELDS.map((g) => (
            <fieldset key={g.group}>
              <legend>{g.group}</legend>
              {g.fields.map((f) => (
                <label
                  key={f.key}
                  className={f.kind === 'bool' ? 'b2b-check' : undefined}
                  title={'hint' in f ? f.hint : undefined}
                >
                  <span>{f.label}</span>
                  {input(f)}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      </div>
    </div>
  );
}
