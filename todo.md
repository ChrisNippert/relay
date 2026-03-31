BUGS
* unfriending doesn't kick me out of the chat. Maybe archive chats if no friends? dunno
* When attempting a friend request, there is no place for outgoing friend requests.

* Voice talking status (like on and off) should show up in the voice channel sidebar for self as well 
* Camera causes recipients to hear echo for some reason

* Selecting another voice channel disconnects from one and connects to another, but we encountered an issue where if i join him, it breaks, but if he joins a channel with me, it works fine. Seems to now be the other way around.
* Message button on user popup icon is not centered horizontally, and the text is not centered vertically.

QOL Stuff
* User can choose mono or stereo for voice calls
* Show user mute/deafen/screenshare/camera status in the voice chat sidebar and on the voice chat screen.
* Allow users to change specific other user volumes
* Screenshare should cast audio
* Add audio pre-processing on the client for things like noise and echo cancellation, noise gate, and things like that
* Add emotes
* Highlight replies and mentions if the user is yourself
* Add notification icons to messages that have been unread, and a different color if mentioned
* Update friend UI to not accidentally remove friends.
* be able to right click on names in the voice channels for kick and audio and such
* Separate camera and video feeds as two separate cards on the voice channel page instead of having it tiny and in the corner.
* Make watching people's streams or video feeds optional in the voice channel page.

TODOs later
<!-- * Look into Web transport instead of webrtc maybe? idk webrtc only does peer to peer. -->
* Make sure user registration info is securely stored
* Use turn instead of stun for servers since webrtc doesn't like VPNs apparently

E2EE
* Implement spec listed in protocol
* E2EE still doesn't work. New clients rotate key when sending a message but don't seem to get the old keys.