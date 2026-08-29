// Command ouija-matchmaking is the matchmaking/signaling server.
//
// This is the ONLY server involved in a game. Its job is deliberately
// small: pair a waiting "medium" with a waiting "ghost", then relay the
// WebRTC handshake (SDP offer/answer + ICE candidates) between them so
// their browsers can open a direct RTCDataChannel. Once that channel is
// open, this server is no longer part of the conversation — planchette
// movement travels peer-to-peer, not through here.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"

	"github.com/gorilla/websocket"
)

type Role string

const (
	RoleMedium Role = "medium"
	RoleGhost  Role = "ghost"
	RoleAny    Role = "any"
)

// ---- wire messages ----

type inboundMessage struct {
	Type   string          `json:"type"`
	Role   string          `json:"role,omitempty"`
	RoomID string          `json:"roomId,omitempty"`
	Data   json.RawMessage `json:"data,omitempty"`
}

type matchedMessage struct {
	Type      string `json:"type"`
	RoomID    string `json:"roomId"`
	Role      Role   `json:"role"`
	Initiator bool   `json:"initiator"`
}

type signalMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type peerLeftMessage struct {
	Type string `json:"type"`
}

// ---- player / room ----

type Player struct {
	id   string
	role Role
	send chan []byte
}

type Room struct {
	id     string
	medium *Player
	ghost  *Player
}

// ---- hub ----
//
// Every connection gets its own read/write goroutine, but none of them
// touch matchmaking state directly — they all talk to the hub over
// channels, and only the hub's own run() goroutine reads or writes
// `waiting`, `rooms`, and `roomByPlayerID`. That's "share memory by
// communicating" instead of a mutex around a map: it's doing the same job
// the Node version of this server got for free from being single-threaded.

type joinRequest struct {
	player *Player
}

type signalRequest struct {
	fromID string
	roomID string
	data   json.RawMessage
}

type Hub struct {
	waiting        []*Player
	rooms          map[string]*Room
	roomByPlayerID map[string]string

	join       chan joinRequest
	signal     chan signalRequest
	unregister chan string
}

func newHub() *Hub {
	return &Hub{
		rooms:          make(map[string]*Room),
		roomByPlayerID: make(map[string]string),
		join:           make(chan joinRequest),
		signal:         make(chan signalRequest),
		unregister:     make(chan string),
	}
}

func (h *Hub) run() {
	for {
		select {
		case req := <-h.join:
			h.handleJoin(req.player)
		case req := <-h.signal:
			h.handleSignal(req)
		case id := <-h.unregister:
			h.handleUnregister(id)
		}
	}
}

func (h *Hub) removeFromWaiting(id string) {
	for i, p := range h.waiting {
		if p.id == id {
			h.waiting = append(h.waiting[:i], h.waiting[i+1:]...)
			return
		}
	}
}

func (h *Hub) handleJoin(player *Player) {
	h.waiting = append(h.waiting, player)

	var medium, ghost *Player
	for _, p := range h.waiting {
		if p.role == RoleMedium && medium == nil {
			medium = p
		}
		if p.role == RoleGhost && ghost == nil {
			ghost = p
		}
	}

	if medium == nil || ghost == nil {
		// No explicit medium+ghost pair waiting — fall back to pairing up
		// two "any" players and assigning them roles arbitrarily.
		var anyPlayers []*Player
		for _, p := range h.waiting {
			if p.role == RoleAny {
				anyPlayers = append(anyPlayers, p)
			}
		}
		if len(anyPlayers) >= 2 {
			medium, ghost = anyPlayers[0], anyPlayers[1]
		}
	}

	if medium == nil || ghost == nil {
		return
	}

	h.removeFromWaiting(medium.id)
	h.removeFromWaiting(ghost.id)

	roomID := newID()
	room := &Room{id: roomID, medium: medium, ghost: ghost}
	h.rooms[roomID] = room
	h.roomByPlayerID[medium.id] = roomID
	h.roomByPlayerID[ghost.id] = roomID

	// The medium's browser creates the WebRTC offer; an arbitrary but
	// necessary tie-break since two peers can't both go first. It stops
	// mattering the moment the data channel opens — from then on both
	// sides are symmetric peers, nobody's the "host".
	send(medium, matchedMessage{Type: "matched", RoomID: roomID, Role: RoleMedium, Initiator: true})
	send(ghost, matchedMessage{Type: "matched", RoomID: roomID, Role: RoleGhost, Initiator: false})

	log.Printf("[matchmaking] paired room %s", roomID)
}

func (h *Hub) handleSignal(req signalRequest) {
	room, ok := h.rooms[req.roomID]
	if !ok {
		return
	}
	if room.medium.id != req.fromID && room.ghost.id != req.fromID {
		return
	}

	target := room.ghost
	if room.medium.id != req.fromID {
		target = room.medium
	}
	send(target, signalMessage{Type: "signal", Data: req.data})
}

func (h *Hub) handleUnregister(id string) {
	h.removeFromWaiting(id)

	roomID, ok := h.roomByPlayerID[id]
	if !ok {
		return
	}
	room, ok := h.rooms[roomID]
	if !ok {
		return
	}

	partner := room.ghost
	if room.medium.id != id {
		partner = room.medium
	}
	send(partner, peerLeftMessage{Type: "peer-left"})

	delete(h.rooms, roomID)
	delete(h.roomByPlayerID, room.medium.id)
	delete(h.roomByPlayerID, room.ghost.id)
}

func send(p *Player, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case p.send <- b:
	default:
		// Outbound queue is full — a dead or very slow connection. Drop
		// the message rather than block the hub goroutine on one player.
	}
}

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// ---- HTTP / WebSocket plumbing ----

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true }, // demo only, tighten before real deployment
}

func serveWS(hub *Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Println("upgrade error:", err)
			return
		}

		player := &Player{id: newID(), send: make(chan []byte, 16)}

		go writePump(conn, player)
		readPump(hub, conn, player)
	}
}

func writePump(conn *websocket.Conn, player *Player) {
	defer conn.Close()
	for msg := range player.send {
		if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			return
		}
	}
}

func readPump(hub *Hub, conn *websocket.Conn, player *Player) {
	defer func() {
		hub.unregister <- player.id
		close(player.send)
		conn.Close()
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}

		var msg inboundMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "join":
			role := RoleAny
			if msg.Role == string(RoleMedium) || msg.Role == string(RoleGhost) {
				role = Role(msg.Role)
			}
			player.role = role
			hub.join <- joinRequest{player: player}

		case "signal":
			if msg.RoomID == "" {
				continue
			}
			hub.signal <- signalRequest{fromID: player.id, roomID: msg.RoomID, data: msg.Data}
		}
	}
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	hub := newHub()
	go hub.run()

	http.HandleFunc("/", serveWS(hub))

	log.Printf("[matchmaking] listening on :%s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}
