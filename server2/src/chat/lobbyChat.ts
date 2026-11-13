import type {LobbyChatMessage,UserInfo} from '../../../html5/src/net2/protocol.ts';
import {RequestError} from '../errors.ts';
interface ChatPeer {user:UserInfo|null;send(type:'lobby.chat',data:{message:LobbyChatMessage}):void}
/** ChatOutput's 80-line history, shared in RAM; never writes chat traffic to MySQL. */
export class LobbyChatService {
 private readonly peers=new Set<ChatPeer>();
 private readonly history:LobbyChatMessage[]=[];
 private readonly lastSent=new Map<ChatPeer,number>();
 private sequence=0;
 watch(peer:ChatPeer):LobbyChatMessage[]{if(!peer.user)throw new RequestError('not_authenticated');this.peers.add(peer);return this.history.map(m=>({...m,recipient:m.recipient?{...m.recipient}:undefined}));}
 unwatch(peer:ChatPeer):void {this.peers.delete(peer);}
 remove(peer:ChatPeer):void {this.unwatch(peer);this.lastSent.delete(peer);}
 send(peer:ChatPeer,value:unknown,now=Date.now()):void {
  if(!peer.user)throw new RequestError('not_authenticated');
  if(!this.peers.has(peer))throw new RequestError('forbidden','откройте чат лобби');
  if(typeof value!=='string'||value.length>299)throw new RequestError('bad_request','сообщение должно быть не длиннее 299 символов');
  let text=value.replace(/[\u0000-\u001f\u007f]/g,' ').trim();if(!text)return;
  if(now-(this.lastSent.get(peer)??-Infinity)<1000)throw new RequestError('rate_limited','подождите секунду перед следующим сообщением');
  let recipient:LobbyChatMessage['recipient'];
  const address=/^([a-zA-Z0-9_]{1,20}):\s+([\s\S]+)$/.exec(text);
  if(address){
    const name=address[1].toLowerCase(),user=[...this.peers].find(p=>p.user?.name.toLowerCase()===name)?.user;
    const past=[...this.history].reverse().find(m=>m.author.toLowerCase()===name);
    if(user)recipient={userId:user.id,author:user.name,rank:user.rank};
    else if(past)recipient={userId:past.userId,author:past.author,rank:past.rank};
    if(recipient)text=address[2];
  }
  this.lastSent.set(peer,now);
  const message:LobbyChatMessage={messageId:++this.sequence,userId:peer.user.id,author:peer.user.name,rank:peer.user.rank,text,...(recipient?{recipient}:{} )};
  this.history.push(message);if(this.history.length>80)this.history.shift();
  for(const receiver of this.peers)receiver.send('lobby.chat',{message});
 }
}
