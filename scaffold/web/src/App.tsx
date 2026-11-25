import { useEffect, useRef, useState, type FormEvent } from 'react';
import './app.css';

type User = { sub: string; name: string; workspaces: { id: string; role: string }[] };
type Conversation = { contact: string; activity: string; state: 'open' | 'closed'; assignee: string | null };
type Message = { key: string; direction: 'inbound' | 'outbound'; text: string; time: string; status?: string };
type Thread = Conversation & { messages: Message[] };
type Page = { items: Conversation[]; nextCursor: string | null };
type Filter = 'all' | Conversation['state'];

class RequestError extends Error {
  constructor(public status: number) {
    super(status === 401 ? 'Your session expired. Sign in again to continue.' : 'The request could not be completed.');
  }
}

async function request(path: string, options?: RequestInit) {
  const response = await fetch(path, options);
  if (!response.ok) throw new RequestError(response.status);
  return response;
}

async function read<T>(path: string, options?: RequestInit): Promise<T> {
  return (await request(path, options)).json();
}

function workspaceName(id: string) {
  return id.replace(/^ws_/, '').split(/[_-]/).filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function activityTime(value: string) {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function useLiveUpdates(workspace: string, refresh: () => void) {
  const [online, setOnline] = useState(false);
  const callback = useRef(refresh);
  callback.current = refresh;

  useEffect(() => {
    let active = true;
    let socket: WebSocket;
    let retry: number | undefined;
    let reload: number | undefined;
    let after: number | undefined;
    let delay = 500;
    const scheduleRefresh = () => {
      if (reload !== undefined) return;
      reload = window.setTimeout(() => {
        reload = undefined;
        callback.current();
      }, 120);
    };

    const connect = () => {
      const location = new URL('/ws', window.location.href);
      location.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      location.searchParams.set('workspace', workspace);
      if (after !== undefined) location.searchParams.set('after', String(after));
      socket = new WebSocket(location);
      socket.onopen = () => {
        if (!active) return;
        delay = 500;
        setOnline(true);
        scheduleRefresh();
      };
      socket.onmessage = event => {
        try {
          const frame: { seq: number } = JSON.parse(event.data);
          if (Number.isSafeInteger(frame.seq)) {
            after = frame.seq;
            scheduleRefresh();
          }
        } catch {
          // Ignore invalid frames and keep the last replay cursor.
        }
      };
      socket.onclose = () => {
        if (!active) return;
        setOnline(false);
        scheduleRefresh();
        retry = window.setTimeout(connect, delay);
        delay = Math.min(delay * 2, 5000);
      };
    };
    connect();

    return () => {
      active = false;
      clearTimeout(reload);
      clearTimeout(retry);
      socket.onmessage = null;
      socket.close();
    };
  }, [workspace]);

  return online;
}

function Brand() {
  return <span className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>Switchboard</span>;
}

function StateLabel({ state }: { state: Conversation['state'] }) {
  return <span className={'state-label ' + state}>{state === 'open' ? 'Open' : 'Closed'}</span>;
}

export function App() {
  const [user, setUser] = useState<User | null>();
  const [error, setError] = useState('');
  const [attempt, retry] = useState(0);
  const [workspace, setWorkspace] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    read<User>('/api/me', { signal: controller.signal }).then(session => {
      setUser(session);
      setWorkspace(session.workspaces[0]?.id ?? '');
    }).catch(reason => {
      if (controller.signal.aborted) return;
      if (reason instanceof RequestError && reason.status === 401) setUser(null);
      else setError('Switchboard could not connect. Check that the backend is running.');
    });
    return () => controller.abort();
  }, [attempt]);

  async function signOut() {
    try {
      await request('/auth/logout', { method: 'POST' });
      setUser(null);
      setWorkspace('');
    } catch {
      setError('Sign-out failed. Try again.');
    }
  }

  if (!user) {
    return (
      <main className="signin">
        <div className="signin-card">
          <Brand />
          <h1>Team inbox</h1>
          <p>Sign in to see your workspace conversations and reply to customers.</p>
          {error && <p className="error" role="alert">{error}</p>}
          {error && user === undefined ? (
            <button className="primary" onClick={() => { setError(''); retry(value => value + 1); }}>Retry connection</button>
          ) : user === null ? (
            <a className="primary" href="/auth/login">Sign in</a>
          ) : <p role="status">Checking your session…</p>}
        </div>
      </main>
    );
  }

  return (
    <div className="shell">
      <header className="topbar">
        <Brand />
        <div className="account">
          <span className="account-name">{user.name}</span>
          <button className="quiet" onClick={signOut}>Sign out</button>
        </div>
      </header>
      {error && <p className="global-error error" role="alert">{error}</p>}
      {workspace ? (
        <Workspace key={workspace} id={workspace} user={user} switchWorkspace={setWorkspace}
          onExpired={() => { setError('Your session expired. Sign in again to continue.'); setUser(null); }} />
      ) : <main className="empty"><h1>No workspace access</h1><p>Your account has no workspace memberships.</p></main>}
    </div>
  );
}

function Workspace({ id, user, switchWorkspace, onExpired }: {
  id: string;
  user: User;
  switchWorkspace: (value: string) => void;
  onExpired: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [contact, setContact] = useState<string | null>(null);
  const [conversationPage, setConversationPage] = useState<Page>();
  const [pageCount, setPageCount] = useState(1);
  const [revision, setRevision] = useState(0);
  const [listError, setListError] = useState('');
  const expired = useRef(onExpired);
  expired.current = onExpired;
  const refresh = () => setRevision(value => value + 1);
  const online = useLiveUpdates(id, refresh);
  const membership = user.workspaces.find(workspace => workspace.id === id);
  const name = workspaceName(id);
  const workspaceQuery = new URLSearchParams({ workspace: id });

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const query = new URLSearchParams({ workspace: id });
      if (filter !== 'all') query.set('state', filter);
      const items: Conversation[] = [];
      let nextCursor: string | null = null;
      for (let index = 0; index < pageCount; index += 1) {
        if (nextCursor) query.set('cursor', nextCursor);
        const page = await read<Page>('/api/conversations?' + query, { signal: controller.signal });
        items.push(...page.items);
        nextCursor = page.nextCursor;
        if (!nextCursor) break;
      }
      setConversationPage({ items: [...new Map(items.map(item => [item.contact, item])).values()], nextCursor });
      setListError('');
    }
    load().catch(reason => {
      if (controller.signal.aborted) return;
      if (reason instanceof RequestError && reason.status === 401) expired.current();
      else setListError('Could not load conversations.');
    });
    return () => controller.abort();
  }, [id, filter, pageCount, revision]);

  function selectFilter(value: Filter) {
    if (value === filter) return;
    setConversationPage(undefined);
    setPageCount(1);
    setListError('');
    setFilter(value);
  }

  return (
    <main className={'workspace' + (contact ? ' has-thread' : '')}>
      <aside className="workspace-sidebar" aria-label="Workspace">
        <div className="workspace-identity">
          <span className="workspace-mark" aria-hidden="true">{name.slice(0, 1)}</span>
          <div><strong>{name}</strong><span>{membership?.role}</span></div>
        </div>
        {user.workspaces.length > 1 && (
          <label className="workspace-select">
            <span>Workspace</span>
            <select value={id} onChange={event => switchWorkspace(event.target.value)}>
              {user.workspaces.map(member => <option key={member.id} value={member.id}>{workspaceName(member.id)}</option>)}
            </select>
          </label>
        )}
        <div className="live" role="status"><span className={online ? 'online' : ''} />{online ? 'Live updates' : 'Reconnecting'}</div>
      </aside>
      <section className="inbox-list" aria-labelledby="inbox-heading">
        <header className="list-header">
          <h1 id="inbox-heading">Inbox</h1>
          <div className="filters" aria-label="Filter conversations">
            {(['all', 'open', 'closed'] as const).map(value => (
              <button key={value} aria-pressed={filter === value} onClick={() => selectFilter(value)}>
                {value.charAt(0).toUpperCase() + value.slice(1)}
              </button>
            ))}
          </div>
        </header>
        <div className="conversation-list">
          {listError && <div className="notice"><p className="error" role="alert">{listError}</p><button onClick={refresh}>Retry</button></div>}
          {!conversationPage && !listError && <p className="notice" role="status">Loading conversations…</p>}
          {conversationPage?.items.length === 0 && <p className="notice">No {filter === 'all' ? '' : filter + ' '}conversations yet.</p>}
          {conversationPage?.items.map(item => (
            <button key={item.contact} className="conversation" aria-current={item.contact === contact ? 'true' : undefined}
              onClick={() => setContact(item.contact)}>
              <span className="contact-mark" aria-hidden="true">{item.contact.replace(/\D/g, '').slice(-2) || '•'}</span>
              <span className="conversation-label">
                <strong>{item.contact}</strong>
                <span>{item.assignee === user.sub ? 'Assigned to you' : item.assignee ? 'Assigned' : 'Unassigned'}</span>
              </span>
              <span className="conversation-meta">
                <time dateTime={item.activity}>{activityTime(item.activity)}</time>
                <StateLabel state={item.state} />
              </span>
            </button>
          ))}
          {conversationPage?.nextCursor && <button className="load-more" onClick={() => setPageCount(value => value + 1)}>Load more</button>}
        </div>
      </section>
      <section className="thread" aria-label="Conversation">
        {contact ? (
          <ConversationThread key={contact} contact={contact} agent={user.sub} query={workspaceQuery.toString()}
            revision={revision} refresh={refresh} close={() => setContact(null)} onExpired={onExpired} />
        ) : (
          <div className="empty"><div className="message-mark" aria-hidden="true" />
            <h2>Select a conversation</h2><p>Choose a customer from the inbox to read their messages and reply.</p>
          </div>
        )}
      </section>
    </main>
  );
}

function ConversationThread({ contact, agent, query, revision, refresh, close, onExpired }: {
  contact: string;
  agent: string;
  query: string;
  revision: number;
  refresh: () => void;
  close: () => void;
  onExpired: () => void;
}) {
  const [thread, setThread] = useState<Thread>();
  const [problem, setProblem] = useState('');
  const [actionError, setActionError] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const previousSend = useRef<{ text: string; ref: string } | null>(null);
  const history = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  const path = '/api/conversations/' + encodeURIComponent(contact);
  const lastKey = thread?.messages.at(-1)?.key;

  useEffect(() => {
    const controller = new AbortController();
    read<Thread>(path + '?' + query, { signal: controller.signal }).then(value => {
      setThread(value);
      setProblem('');
    }).catch(reason => {
      if (controller.signal.aborted) return;
      if (reason instanceof RequestError && reason.status === 401) expired.current();
      else setProblem('Could not load this conversation.');
    });
    return () => controller.abort();
  }, [path, query, revision]);

  useEffect(() => {
    if (history.current && followLatest.current) history.current.scrollTop = history.current.scrollHeight;
  }, [lastKey]);

  async function mutate(segment: string, body?: Record<string, string>) {
    setBusy(true);
    setActionError('');
    try {
      await request(path + '/' + segment + '?' + query, {
        method: 'POST',
        ...(body && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      return true;
    } catch (reason) {
      if (reason instanceof RequestError && reason.status === 401) onExpired();
      else if (reason instanceof RequestError && reason.status === 409) setActionError('Another agent already claimed this conversation.');
      else setActionError('The action failed. Try again.');
      return false;
    } finally {
      refresh();
      setBusy(false);
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    const ref = previousSend.current?.text === text ? previousSend.current.ref : crypto.randomUUID();
    previousSend.current = { text, ref };
    followLatest.current = true;
    if (await mutate('replies', { text, client_ref: ref })) {
      previousSend.current = null;
      setDraft(current => current === draft ? '' : current);
    }
  }

  return (
    <>
      <header className="thread-header">
        <button className="quiet back" onClick={close}>Back to inbox</button>
        <div className="thread-title">
          <h2>{contact}</h2>
          {thread && <StateLabel state={thread.state} />}
        </div>
        {thread && (
          <div className="thread-actions">
            {thread.assignee ? <span>{thread.assignee === agent ? 'Assigned to you' : 'Assigned to ' + thread.assignee}</span>
              : <button disabled={busy} onClick={() => void mutate('claim')}>Claim</button>}
            <button disabled={busy} onClick={() => void mutate('state', { state: thread.state === 'open' ? 'closed' : 'open' })}>
              {thread.state === 'open' ? 'Close' : 'Reopen'}
            </button>
          </div>
        )}
      </header>
      <div className="history" ref={history} onScroll={event => {
        const area = event.currentTarget;
        followLatest.current = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
      }}>
        {problem && <div className="notice"><p className="error" role="alert">{problem}</p><button onClick={refresh}>Retry</button></div>}
        {!thread && !problem && <p className="notice" role="status">Loading messages…</p>}
        {thread?.messages.length === 0 && <p className="notice">No messages yet.</p>}
        {thread?.messages.map(message => (
          <article className={'message ' + message.direction} key={message.key} aria-label={message.direction === 'inbound' ? 'Customer message' : 'Team reply'}>
            <p>{message.text}</p>
            <div><time dateTime={message.time} title={new Date(message.time).toLocaleString()}>{activityTime(message.time)}</time>
              {message.status && <span className={'delivery ' + message.status}>{message.status}</span>}
            </div>
          </article>
        ))}
      </div>
      {thread && (
        <form className="composer" onSubmit={send}>
          {actionError && <p className="error" role="alert">{actionError}</p>}
          <label htmlFor="reply">Reply</label>
          <textarea id="reply" maxLength={4000} rows={3} value={draft} onChange={event => setDraft(event.target.value)}
            placeholder="Write to the customer…" />
          <div><button className="primary" type="submit" disabled={busy || !draft.trim()}>Send reply</button></div>
        </form>
      )}
    </>
  );
}
