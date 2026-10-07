import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import type { IngestKeyCreated, ProjectView } from '@snitch/contract';
import { errorText, post } from '../lib/api';
import { qk } from '../lib/queries';
import { useSelectedProject } from '../lib/project';
import { CopyButton, Dialog } from '../components/ui';

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const prefixOf = (s: string) => (s.replace(/[^A-Za-z0-9]/g, '').toUpperCase().replace(/^[0-9]+/, '').slice(0, 4) || 'APP');

export function NewProject({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [, select] = useSelectedProject();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [prefix, setPrefix] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ project: ProjectView; key: IngestKeyCreated } | null>(null);
  const create = useMutation({
    mutationFn: () => post<{ project: ProjectView; key: IngestKeyCreated }>('/projects', { name, slug, ticketPrefix: prefix }),
    onSuccess: (r) => (setCreated(r), void qc.invalidateQueries({ queryKey: qk.projects })),
    onError: (e) => setError(errorText(e)),
  });
  const onName = (v: string) => {
    setName(v);
    if (!touched) {
      setSlug(slugify(v));
      setPrefix(prefixOf(v));
    }
  };
  if (created) {
    return (
      <Dialog
        title={`${created.project.name} is ready`}
        onClose={onClose}
        footer={
          <button
            type="button"
            className="primary"
            onClick={() => {
              select(created.project.id);
              navigate(`/projects/${created.project.id}/settings/install`);
              onClose();
            }}
          >
            Show install steps
          </button>
        }
      >
        <div className="stack">
          <span>Your app sends reports with this ingest key:</span>
          <div className="secret-box">{created.key.plaintext}</div>
          <span className="muted small">Copy it now — only a hash is stored. You can create more keys later.</span>
          <CopyButton text={created.key.plaintext} label="Copy key" />
        </div>
      </Dialog>
    );
  }
  const submit = (e: FormEvent) => (e.preventDefault(), setError(null), create.mutate());
  return (
    <Dialog
      title="New project"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="new-project" className="primary" disabled={create.isPending || !name || !slug || !prefix}>
            Create
          </button>
        </>
      }
    >
      <form id="new-project" className="form" onSubmit={submit}>
        <label className="field">
          App name
          <input value={name} onChange={(e) => onName(e.target.value)} required autoFocus maxLength={80} placeholder="Mochiro" />
        </label>
        <div className="form-row">
          <label className="field">
            Slug
            <input className="mono" value={slug} onChange={(e) => (setTouched(true), setSlug(slugify(e.target.value)))} required />
          </label>
          <label className="field">
            Ticket prefix
            <input className="mono" value={prefix} onChange={(e) => (setTouched(true), setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)))} required />
            <span className="field-hint">Tickets will be {prefix || 'APP'}-1, {prefix || 'APP'}-2…</span>
          </label>
        </div>
        {error && <div className="error-text">{error}</div>}
      </form>
    </Dialog>
  );
}
