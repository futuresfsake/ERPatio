import { useAuth } from '../auth';
import { EntryEditor } from './EntryEditor';

export function NewEntry() {
  const { can } = useAuth();
  if (!can('journal:post')) return <div className="notice error" role="alert">Your role can read the journal but not post to it.</div>;
  return <EntryEditor />;
}
