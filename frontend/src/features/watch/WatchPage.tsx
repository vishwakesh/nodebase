import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, Check, CircleAlert, Clock3, Copy, Film, Globe2, Link2, LockKeyhole,
  MessageCircle, MoreHorizontal, Pause, Play, Plus, Radio, RefreshCw, Send,
  ShieldCheck, UploadCloud, Users, Video, X
} from 'lucide-react';

type ApiFn = <T = any>(url: string, options?: RequestInit) => Promise<T>;
type VideoFile = { id: string; name: string; size: number; mime_type: string; created_at: string; updated_at?: string };
type RoomRow = { id: string; title: string; description: string; visibility: string; status: string; video_name: string; participant_count: number; created_at: string };
type WatchRoom = {
  room: { id: string; title: string; description: string; category: string; visibility: string; status: string; participantLimit: number; approvalRequired: boolean; chatEnabled: boolean; viewerControlEnabled: boolean; ownerId: string };
  video: { id: string; name: string; size: number; mimeType: string; delivery: string; streamReady: boolean } | null;
  playback: { state: 'playing'|'paused'|'ended'; positionMs: number; playbackRate: number; sequence: number; serverTime: string };
  participants: Array<{ id: string; display_name: string; role: string; status: string; joined_at: string }>;
  queue: Array<{ id: string; position: number; file_id: string; name: string; size: number; mime_type: string }>;
  messages: Array<{ id: string; body: string; display_name: string; role: string; created_at: string }>;
  permissions?: { isHost:boolean; canControl:boolean; canInvite:boolean; canManageParticipants:boolean; canManageQueue:boolean };
};
const bytes = (value: number) => value < 1024**2 ? `${(value/1024).toFixed(1)} KB` : `${(value/1024**2).toFixed(1)} MB`;
const clock = (value: number) => `${Math.floor(value/60).toString().padStart(2,'0')}:${Math.floor(value%60).toString().padStart(2,'0')}`;

export function WatchPage({ api, ping, onUpload }: { api: ApiFn; ping: (message: string, type?: 'success'|'error'|'info') => void; onUpload: () => void }) {
  const [videos,setVideos] = useState<VideoFile[]>([]);
  const [rooms,setRooms] = useState<RoomRow[]>([]);
  const [discovery,setDiscovery] = useState<any[]>([]);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [selected,setSelected] = useState<WatchRoom|null>(null);
  const [modal,setModal] = useState(false);
  const [invite,setInvite] = useState<{url:string;id:string}|null>(null);
  const [search,setSearch] = useState('');
  const [message,setMessage] = useState('');
  const [queueFile,setQueueFile] = useState('');
  const videoRef = useRef<HTMLVideoElement|null>(null);
  const syncingPlayer = useRef(false);
  const syncTimer = useRef<number|undefined>(undefined);
  const messageEndRef = useRef<HTMLDivElement|null>(null);
  const refresh = useCallback(async () => {
    try {
      const [overview, discoveryData] = await Promise.all([
        api<{videos:VideoFile[];rooms:RoomRow[];capabilities:any}>('/api/watch/overview'),
        api<{rooms:any[]}>('/api/watch/discovery')
      ]);
      setVideos(overview.videos); setRooms(overview.rooms); setDiscovery(discoveryData.rooms); setError('');
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  },[api]);
  useEffect(()=>{ void refresh(); },[refresh]);

  const loadRoom = useCallback(async (id: string) => {
    try { const value = await api<WatchRoom>(`/api/watch/rooms/${id}`); setSelected(value); }
    catch (e) { ping((e as Error).message,'error'); }
  },[api,ping]);

  useEffect(()=>{
    if (!selected) return;
    const roomId=selected.room.id;
    const timer = window.setInterval(async()=>{
      try {
        const snapshot=await api<WatchRoom>(`/api/watch/rooms/${roomId}`);
        setSelected(snapshot);
        const player=videoRef.current;
        if(player) {
          const target=snapshot.playback.positionMs/1000;
          let shouldSuppress=false;
          if(snapshot.playback.state==='playing') {
            if(Math.abs(player.currentTime-target)>2.2 && !player.seeking) { player.currentTime=target; shouldSuppress=true; }
            if(player.paused && !player.ended) { shouldSuppress=true; void player.play().catch(()=>undefined); }
          } else if(snapshot.playback.state==='paused' && !player.paused) { player.pause(); shouldSuppress=true; }
          if(shouldSuppress) {
            syncingPlayer.current=true;
            if(syncTimer.current!==undefined) window.clearTimeout(syncTimer.current);
            syncTimer.current=window.setTimeout(()=>{syncingPlayer.current=false;syncTimer.current=undefined;},500);
          }
        }
      } catch { /* A failed poll is reflected by the next successful snapshot. */ }
    },3000);
    return()=>{window.clearInterval(timer);if(syncTimer.current!==undefined)window.clearTimeout(syncTimer.current);syncingPlayer.current=false;syncTimer.current=undefined;};
  },[selected?.room.id,api]);
  useEffect(()=>{ messageEndRef.current?.scrollIntoView({behavior:'smooth',block:'end'}); },[selected?.messages.length]);

  const playback = async(action:'play'|'pause'|'seek'|'end', position?:number) => {
    if(!selected || !selected.permissions?.canControl) return;
    try {
      const result=await api<{playback:WatchRoom['playback']}>(`/api/watch/rooms/${selected.room.id}/playback`,{method:'POST',body:JSON.stringify({action,positionMs:Math.max(0,Math.round((position??videoRef.current?.currentTime??0)*1000))})});
      setSelected(current=>current?({...current,playback:result.playback}):current);
    } catch(e) { ping((e as Error).message,'error'); }
  };
  const createRoom = async (event:React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form=new FormData(event.currentTarget);
    try {
      const result=await api<WatchRoom>('/api/watch/rooms',{method:'POST',body:JSON.stringify({
        title:String(form.get('title')||''),description:String(form.get('description')||''),category:String(form.get('category')||'General'),
        videoFileId:String(form.get('videoFileId')||''),visibility:String(form.get('visibility')||'private'),participantLimit:Number(form.get('participantLimit')||12),
        approvalRequired:form.get('approvalRequired')==='on',chatEnabled:form.get('chatEnabled')==='on',viewerControlEnabled:false
      })});
      setModal(false);setSelected(result);await refresh();ping('Watch room created. Invite friends when you are ready.');
    } catch(e) { ping((e as Error).message,'error'); }
  };
  const createInvite = async () => {
    if(!selected)return;
    try { const result=await api<{invitation:{id:string;token:string;expiresAt:string}}> (`/api/watch/rooms/${selected.room.id}/invitations`,{method:'POST',body:JSON.stringify({expiresInHours:24,maxUses:20})}); const url=`${window.location.origin}/#watchInvite=${encodeURIComponent(result.invitation.token)}`; setInvite({url,id:result.invitation.id}); }
    catch(e) { ping((e as Error).message,'error'); }
  };
  const sendMessage = async (event:React.FormEvent) => {
    event.preventDefault(); if(!selected || !message.trim())return;
    try { await api(`/api/watch/rooms/${selected.room.id}/messages`,{method:'POST',body:JSON.stringify({body:message.trim()})}); setMessage(''); const r=await api<{messages:WatchRoom['messages']}>(`/api/watch/rooms/${selected.room.id}/messages`);setSelected(c=>c?({...c,messages:r.messages}):c); }
    catch(e) { ping((e as Error).message,'error'); }
  };
  const addQueue = async () => {
    if(!selected || !queueFile)return;
    try { await api(`/api/watch/rooms/${selected.room.id}/queue`,{method:'POST',body:JSON.stringify({fileId:queueFile})}); await loadRoom(selected.room.id);setQueueFile('');ping('Added to the watch queue.'); }
    catch(e) { ping((e as Error).message,'error'); }
  };
  const endRoom = async () => {
    if(!selected || !window.confirm('End this watch room and revoke its invitations?'))return;
    try { await api(`/api/watch/rooms/${selected.room.id}/end`,{method:'POST',body:JSON.stringify({})});setSelected(null);setInvite(null);await refresh();ping('Watch room ended.'); }
    catch(e) { ping((e as Error).message,'error'); }
  };
  const filteredVideos=videos.filter(v=>v.name.toLowerCase().includes(search.toLowerCase()));

  return <main className="page-content watch-page">
    <div className="watch-heading"><div><div className="eyebrow">PERSONAL WORKSPACE / WATCH</div><h1>Watch together.</h1><p>Private rooms for videos in your NODEBASE Cloud.</p></div><div className="watch-heading-actions"><button className="btn btn-secondary" onClick={onUpload}><UploadCloud size={16}/> Upload video</button><button className="btn btn-primary" onClick={()=>setModal(true)}><Plus size={17}/> Create room</button></div></div>
    <div className="watch-notice"><ShieldCheck size={17}/><span><b>Private by default.</b> Discoverable rooms still require an invitation or host approval. Only MP4 and WebM files are currently playable in this alpha.</span></div>
    {error&&<div className="inline-alert danger-alert"><CircleAlert size={17}/><div><b>Watch data unavailable</b><span>{error}</span></div><button className="btn btn-secondary" onClick={()=>void refresh()}><RefreshCw size={14}/> Retry</button></div>}
    {selected ? <section className="watch-room-layout">
      <div className="watch-main-column">
        <div className="watch-room-topline"><button className="watch-back" onClick={()=>{setSelected(null);setInvite(null);void refresh()}}><ArrowLeft size={15}/> All rooms</button><div className="watch-room-badges"><span className="watch-pill private"><LockKeyhole size={12}/> {selected.room.visibility==='private'?'Private':'Discoverable'}</span><span className="watch-pill live"><i/> {selected.room.status==='ended'?'Ended':selected.playback.state==='playing'?'Playing':'Room ready'}</span></div></div>
        {!selected.permissions?.canControl&&<div className="watch-notice"><LockKeyhole size={15}/><span>The host controls the shared timeline. You can start playback locally if your browser blocks automatic playback.</span></div>}
        <div className="watch-player-frame"><video ref={videoRef} key={selected.room.id} controls playsInline preload="metadata" src={`/api/watch/rooms/${selected.room.id}/media`} onPlay={e=>{if(!syncingPlayer.current)void playback('play',e.currentTarget.currentTime)}} onPause={e=>{if(!syncingPlayer.current&&!e.currentTarget.ended)void playback('pause',e.currentTarget.currentTime)}} onSeeked={e=>{if(!syncingPlayer.current)void playback('seek',e.currentTarget.currentTime)}} /></div>
        <div className="watch-now-playing"><div><span className="watch-overline">NOW IN THIS ROOM</span><h2>{selected.video?.name??selected.room.title}</h2><p>{selected.room.title} · {selected.participants.filter(p=>p.status==='joined').length} participants</p></div>{selected.permissions?.canInvite&&<button className="btn btn-secondary" onClick={createInvite}><Link2 size={15}/> Invite</button>}</div>
        {invite&&<div className="watch-invite-box"><div><b>Room invitation link</b><small>Expires in 24 hours · up to 20 uses</small><code>{invite.url}</code></div><button className="btn btn-primary" onClick={()=>{void navigator.clipboard.writeText(invite.url).then(()=>ping('Invitation link copied.')).catch(()=>ping('Copy failed. Please copy the link manually.','error'))}}><Copy size={15}/> Copy</button><button className="btn btn-danger btn-mini" onClick={async()=>{try{await api(`/api/watch/invitations/${invite.id}`,{method:'DELETE'});setInvite(null);ping('Invitation revoked.')}catch(e){ping((e as Error).message,'error')}}}>Revoke</button><button className="icon-btn" aria-label="Close invite" onClick={()=>setInvite(null)}><X size={17}/></button></div>}
        <div className="watch-detail-grid">
          <section className="panel watch-subpanel"><div className="watch-subheading"><div><span className="watch-overline">ROOM CHAT</span><h3>Conversation</h3></div><span className="watch-count">{selected.messages.length}</span></div>
            <div className="watch-chat-list">{selected.room.chatEnabled?selected.messages.map(m=><div className="watch-message" key={m.id}><span className="watch-message-avatar">{m.display_name.slice(0,1).toUpperCase()}</span><div><b>{m.display_name}{m.role==='host'&&<em>HOST</em>}</b><p>{m.body}</p><small>{new Date(m.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</small></div></div>):<div className="watch-muted-state">Chat is disabled for this room.</div>}<div ref={messageEndRef}/></div>
            {selected.room.chatEnabled&&<form className="watch-chat-compose" onSubmit={sendMessage}><input value={message} onChange={e=>setMessage(e.target.value)} placeholder="Message the room…" maxLength={1000}/><button aria-label="Send message" type="submit" disabled={!message.trim()}><Send size={16}/></button></form>}
          </section>
          <section className="panel watch-subpanel"><div className="watch-subheading"><div><span className="watch-overline">WATCH QUEUE</span><h3>Up next</h3></div><span className="watch-count">{selected.queue.length}</span></div>
            <div className="watch-queue-list">{selected.queue.length?selected.queue.map((item,i)=><div className="watch-queue-item" key={item.id}><span className="watch-queue-index">{i+1}</span><span className="watch-video-placeholder"><Film size={18}/></span><span className="watch-queue-copy"><b>{item.name}</b><small>{item.mime_type} · {bytes(item.size||0)}</small></span>{selected.permissions?.canManageQueue&&<button className="icon-btn" title="Remove from queue" onClick={async()=>{try{await api(`/api/watch/rooms/${selected.room.id}/queue/${item.id}`,{method:'DELETE'});await loadRoom(selected.room.id)}catch(e){ping((e as Error).message,'error')}}}><X size={15}/></button>}</div>):<div className="watch-muted-state">No upcoming videos.</div>}</div>
            {selected.permissions?.canManageQueue&&<div className="watch-add-queue"><select value={queueFile} onChange={e=>setQueueFile(e.target.value)}><option value="">Choose a Cloud video…</option>{videos.filter(v=>v.id!==selected.video?.id).map(v=><option value={v.id} key={v.id}>{v.name}</option>)}</select><button className="btn btn-secondary" disabled={!queueFile} onClick={()=>void addQueue()}><Plus size={14}/> Add</button></div>}
          </section>
        </div>
      </div>
      <aside className="watch-room-sidebar panel"><div className="watch-subheading"><div><span className="watch-overline">ROOM PEOPLE</span><h3>Participants</h3></div><span className="watch-count">{selected.participants.filter(p=>p.status==='joined').length}</span></div>
        <div className="watch-participant-list">{selected.participants.map(person=><div className="watch-participant" key={person.id}><span className="watch-participant-avatar">{person.display_name.slice(0,1).toUpperCase()}</span><span><b>{person.display_name}</b><small>{person.status==='pending'?'Awaiting approval':person.role}</small></span>{person.role==='host'&&<span className="watch-host-tag">HOST</span>}{person.status==='pending'&&selected.permissions?.canManageParticipants&&<button className="btn btn-soft btn-mini" onClick={async()=>{try{await api(`/api/watch/rooms/${selected.room.id}/participants/${person.id}/approve`,{method:'POST',body:JSON.stringify({})});await loadRoom(selected.room.id)}catch(e){ping((e as Error).message,'error')}}}>Approve</button>}{person.status==='joined'&&person.role!=='host'&&selected.permissions?.canManageParticipants&&<button className="btn btn-danger btn-mini" onClick={async()=>{if(!window.confirm(`Remove ${person.display_name} from this room?`))return;try{await api(`/api/watch/rooms/${selected.room.id}/participants/${person.id}`,{method:'DELETE'});await loadRoom(selected.room.id);ping('Participant removed.')}catch(e){ping((e as Error).message,'error')}}}>Remove</button>}</div>)}</div>
        <div className="watch-room-sidebar-actions">{selected.permissions?.canInvite&&<button className="btn btn-secondary" onClick={createInvite}><Link2 size={15}/> Invite friends</button>}{selected.permissions?.isHost?<button className="btn btn-danger" onClick={()=>void endRoom()}>End room</button>:<button className="btn btn-secondary" onClick={async()=>{try{await api(`/api/watch/rooms/${selected.room.id}/leave`,{method:'POST',body:JSON.stringify({})});setSelected(null);await refresh();ping('You left the watch room.')}catch(e){ping((e as Error).message,'error')}}}>Leave room</button>}</div>
        <div className="watch-room-meta"><div><span>Room ID</span><code>{selected.room.id.slice(0,8)}</code></div><div><span>Visibility</span><b>{selected.room.visibility==='private'?'Private':'Discoverable private'}</b></div><div><span>Participant limit</span><b>{selected.room.participantLimit}</b></div></div>
      </aside>
    </section> : <>
      <section className="watch-hero"><div className="watch-hero-copy"><span className="watch-overline">NODEBASE WATCH</span><h2>Your videos.<br/><span>Your people.</span></h2><p>Choose a video from Cloud, open a private room, and watch on a shared timeline.</p><div className="watch-hero-actions"><button className="btn btn-primary" onClick={()=>setModal(true)}><Play size={16} fill="currentColor"/> Create watch room</button><button className="btn btn-secondary" onClick={onUpload}><UploadCloud size={16}/> Upload video</button></div><div className="watch-hero-foot"><span><LockKeyhole size={13}/> Invite-controlled access</span><span><Users size={13}/> Synchronized room state</span></div></div><div className="watch-hero-art"><div className="watch-art-orbit orbit-one"/><div className="watch-art-orbit orbit-two"/><div className="watch-art-screen"><Film size={36}/><span>WATCH</span><small>PRIVATE VIDEO ROOMS</small></div><div className="watch-art-chip"><i/> Room ready</div></div></section>
      <div className="watch-section-heading"><div><span className="watch-overline">YOUR LIBRARY</span><h2>Videos in Cloud</h2><p>Only uploaded MP4 and WebM videos are listed here.</p></div><div className="watch-search"><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search videos…"/><Film size={16}/></div></div>
      {loading?<div className="watch-empty"><RefreshCw className="spin"/><b>Loading your video library…</b></div>:filteredVideos.length?<div className="watch-video-grid">{filteredVideos.map(video=><article className="watch-video-card" key={video.id}><div className="watch-video-art"><Film size={28}/><span>VIDEO</span><small>{video.mime_type.replace('video/','').toUpperCase()}</small></div><div className="watch-video-info"><b title={video.name}>{video.name}</b><small>{bytes(video.size)} · Added {new Date(video.created_at).toLocaleDateString()}</small><button className="btn btn-primary btn-full" onClick={async()=>{try{const result=await api<WatchRoom>('/api/watch/rooms',{method:'POST',body:JSON.stringify({title:video.name.replace(/\.[^.]+$/,'').slice(0,96),videoFileId:video.id,visibility:'private'})});setSelected(result);await refresh();ping('Private watch room created.')}catch(e){ping((e as Error).message,'error')}}}><Plus size={14}/> Create room</button></div></article>)}</div>:<div className="watch-empty"><Film size={28}/><b>{search?'No matching videos':'No playable videos yet'}</b><p>Upload an MP4 or WebM file to NODEBASE Cloud. It will appear here when stored.</p><button className="btn btn-secondary" onClick={onUpload}><UploadCloud size={15}/> Open Cloud uploads</button></div>}
      <div className="watch-section-heading"><div><span className="watch-overline">YOUR SESSIONS</span><h2>Watch rooms</h2><p>Your active and previous viewing rooms.</p></div><button className="btn btn-secondary" onClick={()=>void refresh()}><RefreshCw size={14}/> Refresh</button></div>
      {rooms.length?<div className="watch-room-cards">{rooms.map(room=><button className="watch-room-card" key={room.id} onClick={()=>void loadRoom(room.id)}><span className="watch-room-card-icon"><Radio size={19}/></span><span className="watch-room-card-copy"><b>{room.title}</b><small>{room.video_name} · {room.participant_count} watching</small></span><span className={`watch-pill ${room.visibility==='private'?'private':'discoverable'}`}>{room.visibility==='private'?'Private':'Discoverable'}</span><span className="watch-room-card-status">{room.status}</span></button>)}</div>:<div className="watch-empty compact"><Users size={24}/><b>No watch rooms yet</b><p>Create a room from one of your videos to invite friends.</p></div>}
      {discovery.length>0&&<><div className="watch-section-heading"><div><span className="watch-overline">COMMUNITY</span><h2>Discoverable rooms</h2><p>Visible room listings. Access remains controlled by each host.</p></div></div><div className="watch-room-cards">{discovery.map(room=><div className="watch-room-card" key={room.id}><span className="watch-room-card-icon"><Globe2 size={19}/></span><span className="watch-room-card-copy"><b>{room.title}</b><small>Hosted by {room.host_name} · {room.participant_count} watching</small></span>{room.my_status==='joined'?<button className="btn btn-soft btn-mini" onClick={()=>void loadRoom(room.id)}>Open room</button>:<button className="btn btn-secondary btn-mini" disabled={room.my_status==='pending'} onClick={async()=>{try{const r=await api<any>(`/api/watch/discovery/${room.id}/request`,{method:'POST',body:JSON.stringify({})});ping(r.message,r.status==='pending'?'info':'success');await refresh()}catch(e){ping((e as Error).message,'error')}}}>{room.my_status==='pending'?'Requested':room.approval_required?'Request access':'Join room'}</button>}</div>)}</div></>}
    </>}
    {modal&&<div className="watch-modal-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(false)}}><form className="watch-create-modal" onSubmit={createRoom}><div className="watch-modal-heading"><div><span className="watch-overline">NEW WATCH ROOM</span><h2>Create a room</h2><p>Choose a video and set how friends can join.</p></div><button className="icon-btn" type="button" onClick={()=>setModal(false)} aria-label="Close"><X size={19}/></button></div><label>Room title<input name="title" required minLength={2} maxLength={100} placeholder="Friday movie night"/></label><label>Description <span>(optional)</span><textarea name="description" maxLength={500} placeholder="Add a note for your friends…"/></label><label>Video<select name="videoFileId" required defaultValue=""> <option value="" disabled>Select from Cloud…</option>{videos.map(v=><option value={v.id} key={v.id}>{v.name}</option>)}</select></label><div className="watch-form-grid"><label>Visibility<select name="visibility"><option value="private">Private · invite only</option><option value="discoverable_private">Discoverable · approval controlled</option></select></label><label>Participant limit<select name="participantLimit" defaultValue="12">{[2,4,6,8,12,16,20,25,50].map(n=><option value={n} key={n}>{n} people</option>)}</select></label></div><label>Category<select name="category"><option>General</option><option>Anime</option><option>Movies</option><option>Series</option><option>Education</option><option>Creator videos</option></select></label><div className="watch-checkboxes"><label><input type="checkbox" name="approvalRequired"/> Require host approval to join</label><label><input type="checkbox" name="chatEnabled" defaultChecked/> Enable room chat</label></div><div className="watch-modal-actions"><button type="button" className="btn btn-secondary" onClick={()=>setModal(false)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={!videos.length}><Plus size={15}/> Create room</button></div></form></div>}
  </main>;
}

export function WatchInviteAccess({ api, token, onJoined }: { api:ApiFn; token:string; onJoined:(roomId:string)=>void }) {
  const [room,setRoom]=useState<any>(null);const [name,setName]=useState('');const [error,setError]=useState('');const [loading,setLoading]=useState(true);const [joining,setJoining]=useState(false);
  useEffect(()=>{let active=true;api<{room:any}>('/api/watch/invitations/resolve',{method:'POST',body:JSON.stringify({token})}).then(r=>{if(active)setRoom(r.room)}).catch(e=>{if(active)setError((e as Error).message)}).finally(()=>{if(active)setLoading(false)});return()=>{active=false}},[api,token]);
  const join=async(e:React.FormEvent)=>{e.preventDefault();setJoining(true);setError('');try{const r=await api<{roomId:string}>('/api/watch/invitations/join',{method:'POST',body:JSON.stringify({token,displayName:name})});onJoined(r.roomId)}catch(e){setError((e as Error).message)}finally{setJoining(false)}};
  return <div className="watch-guest-shell"><form className="watch-guest-card" onSubmit={join}><div className="watch-guest-mark"><Play size={23}/></div><span className="watch-overline">NODEBASE WATCH INVITATION</span><h1>{loading?'Checking invitation…':room?.title??'Invitation unavailable'}</h1>{room&&<><p>Hosted by {room.hostName}. {room.description}</p><div className="watch-guest-meta"><span><Users size={14}/>{room.participantCount}/{room.participantLimit} people</span><span><LockKeyhole size={14}/>{room.approvalRequired?'Host approval':'Invitation access'}</span></div><label>Your display name<input value={name} onChange={e=>setName(e.target.value)} minLength={2} maxLength={40} required placeholder="How friends will see you"/></label><button className="btn btn-primary btn-full" disabled={joining}>{joining?'Joining…':'Join watch room'} <ArrowLeft size={15}/></button></>}{error&&<div className="watch-form-error"><CircleAlert size={15}/>{error}</div>}<small>Joining grants access to this room only, not the host’s Cloud or account.</small></form></div>;
}

export function WatchGuestRoom({ api, roomId }: { api:ApiFn; roomId:string }) {
  const [snapshot,setSnapshot]=useState<any>(null);const [error,setError]=useState('');const [message,setMessage]=useState('');const [needsGesture,setNeedsGesture]=useState(false);const player=useRef<HTMLVideoElement|null>(null);const syncing=useRef(false);
  const load=useCallback(async()=>{try{const r=await api<any>(`/api/watch/guest/${roomId}`);setSnapshot(r);setError('')}catch(e){setError((e as Error).message)}},[api,roomId]);
  useEffect(()=>{void load();const timer=window.setInterval(()=>void load(),4000);return()=>window.clearInterval(timer)},[load]);
  useEffect(()=>{if(snapshot?.status!=='joined')return;let live=true;const timer=window.setInterval(async()=>{try{const r=await api<any>(`/api/watch/guest/${roomId}/playback`);if(!live)return;const v=player.current;if(v){const target=r.playback.positionMs/1000;let changed=false;syncing.current=true;if(Math.abs(v.currentTime-target)>2.2&&!v.seeking){v.currentTime=target;changed=true}if(r.playback.state==='playing'&&v.paused){void v.play().then(()=>setNeedsGesture(false)).catch(()=>setNeedsGesture(true));changed=true}if(r.playback.state==='paused'&&!v.paused){v.pause();changed=true}if(changed)window.setTimeout(()=>{syncing.current=false},350);else syncing.current=false}}catch{}},3000);return()=>{live=false;window.clearInterval(timer)}},[api,roomId,snapshot?.status]);
  const startSyncedPlayback=()=>{const v=player.current;if(!v)return;v.currentTime=Math.max(0,(snapshot?.playback?.positionMs??0)/1000);void v.play().then(()=>setNeedsGesture(false)).catch(()=>setNeedsGesture(true))};
  const send=async(e:React.FormEvent)=>{e.preventDefault();if(!message.trim())return;try{await api(`/api/watch/guest/${roomId}/messages`,{method:'POST',body:JSON.stringify({body:message.trim()})});setMessage('');await load()}catch(e){setError((e as Error).message)}};
  if(error)return <div className="watch-guest-shell"><div className="watch-guest-card"><CircleAlert size={24}/><h1>Room access unavailable</h1><p>{error}</p><button className="btn btn-secondary" onClick={()=>void load()}>Try again</button></div></div>;
  if(!snapshot||snapshot.status==='pending')return <div className="watch-guest-shell"><div className="watch-guest-card"><Clock3 size={28}/><h1>Waiting for approval</h1><p>{snapshot?.message??'Checking your room access…'}</p></div></div>;
  return <main className="watch-guest-room"><header><b>NODEBASE <span>WATCH</span></b><span>{snapshot.room.title}</span><button className="btn btn-secondary btn-mini" onClick={async()=>{try{await api(`/api/watch/guest/${roomId}/leave`,{method:'POST',body:JSON.stringify({})});window.location.href='/'}catch(e){setError((e as Error).message)}}}>Leave room</button></header><div className="watch-guest-player"><video ref={player} controls playsInline preload="metadata" src={`/api/watch/guest/${roomId}/media`} onPlay={e=>{if(syncing.current||!snapshot.room.viewerControlEnabled)return;const v=e.currentTarget;void api(`/api/watch/guest/${roomId}/playback`,{method:'POST',body:JSON.stringify({action:'play',positionMs:Math.round(v.currentTime*1000)})}).catch(()=>void load())}} onPause={e=>{if(syncing.current||e.currentTarget.ended||!snapshot.room.viewerControlEnabled)return;const v=e.currentTarget;void api(`/api/watch/guest/${roomId}/playback`,{method:'POST',body:JSON.stringify({action:'pause',positionMs:Math.round(v.currentTime*1000)})}).catch(()=>void load())}} onSeeked={e=>{if(syncing.current||!snapshot.room.viewerControlEnabled)return;const v=e.currentTarget;void api(`/api/watch/guest/${roomId}/playback`,{method:'POST',body:JSON.stringify({action:'seek',positionMs:Math.round(v.currentTime*1000)})}).catch(()=>void load())}}/>{needsGesture&&snapshot.playback.state==='playing'&&<button className="watch-gesture-play" onClick={()=>void startSyncedPlayback()}><Play size={16} fill="currentColor"/> Start synced playback</button>}</div><section className="watch-guest-lower"><div><h1>{snapshot.room.title}</h1><p>You're watching as {snapshot.participant.displayName}. {snapshot.room.viewerControlEnabled?'Room members can control the shared timeline.':'The host controls the shared timeline.'}</p><div className="watch-participant-chips">{snapshot.participants.map((p:any)=><span key={p.id}>{p.display_name}{p.role==='host'?' · Host':''}</span>)}</div></div><section className="watch-guest-chat"><b><MessageCircle size={15}/> Room chat</b><div className="watch-guest-chat-list">{snapshot.messages.map((m:any)=><p key={m.id}><strong>{m.display_name}:</strong> {m.body}</p>)}</div><form onSubmit={send}><input value={message} onChange={e=>setMessage(e.target.value)} placeholder="Message room…" maxLength={1000}/><button disabled={!message.trim()}><Send size={15}/></button></form></section></section></main>;
}
