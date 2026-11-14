import { Link } from 'react-router-dom';

/** Privacy notice, version 2026-11 (the version is recorded with each person's consent). */
export function Privacy() {
  return (
    <div style={{ maxWidth: 720, padding: '40px 24px 80px 56px', margin: '0 auto', position: 'relative' }}>
      <div className="wordmark" style={{ padding: 0, fontSize: 24 }}><Link to="/login" style={{ textDecoration: 'none' }}>ERPatio</Link></div>
      <h1 style={{ marginTop: 28 }}>Privacy notice</h1>
      <p className="muted" style={{ marginTop: 6 }}>Version 2026-11</p>
      <div className="stack" style={{ marginTop: 24, gap: 22, lineHeight: 1.6 }}>
        <section><h2>Who this is for</h2><p style={{ marginTop: 6 }}>People who sign in to an ERPatio workspace. Your company is the controller of its accounting data. ERPatio processes it for your company to run the service.</p></section>
        <section><h2>What we hold about you</h2>
          <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
            <li>Your name, work email and role.</li>
            <li>The password you chose, stored only as a one-way hash.</li>
            <li>Your sign-in history: time, network address and browser.</li>
            <li>A record of what you did in the workspace (the audit log), because accounting law and your auditors require it.</li>
            <li>Your consent to this notice, with its version and time.</li>
          </ul>
        </section>
        <section><h2>Why</h2><p style={{ marginTop: 6 }}>To sign you in, keep your company's books, protect the service from abuse, and meet record-keeping duties. We do not sell your data and we do not use it for advertising.</p></section>
        <section><h2>How long</h2><p style={{ marginTop: 6 }}>Sign-in tokens and one-time email links are removed 30 days after they expire. Financial records and the audit log are kept for the statutory period.</p></section>
        <section><h2>Your rights</h2>
          <p style={{ marginTop: 6 }}>You can download everything held about you from <b>Account security</b>. You can ask your workspace administrator to erase you. Because financial records must be kept, erasure replaces your name and email with a pseudonym and clears your addresses; the ledger is not changed.</p>
        </section>
        <section><h2>Where it is stored</h2><p style={{ marginTop: 6 }}>In Singapore, with Neon (database) and Render (application hosting). The full list of services that can touch your data is kept up to date by the operator.</p></section>
        <section><h2>Security</h2><p style={{ marginTop: 6 }}>Connections are encrypted. Each company's data is separated by the database itself. Passwords are hashed, two-factor sign-in is available, and sensitive fields are encrypted before they are stored.</p></section>
        <section><h2>Questions or a complaint</h2><p style={{ marginTop: 6 }}>Ask your workspace administrator first. You may also complain to the National Privacy Commission in the Philippines.</p></section>
      </div>
      <p style={{ marginTop: 28 }}><Link to="/login">Back to sign in</Link></p>
    </div>
  );
}
