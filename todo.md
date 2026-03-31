BUGS
* Users in voice chat have their uids displayed instead of their names
* Use turn instead of stun for servers since webrtc doesn't like VPNs apparently
* Leave button required before joining another voice channel, otherwise it dies
* Users joins when another user is streaming, it doesn't show up for the new user
* When a user stops their video feed, it freezes on them at their last frame. When they reshare, its still stuck on that freeze frame
* Doesn't Auto resolve mentions to the username in the server
* No bold italicized formatting
* Message button on user popup icon is not centered horizontally, and the text is not centered vertically.
* Implement a text limit and above that limit (maybe like 5000 characters) convert to a message.txt file

TODOs later
* E2EE still doesn't work
<!-- * Look into Web transport instead of webrtc maybe? idk webrtc only does peer to peer. -->

QOL Stuff
* User can choose mono or stereo for voice calls
* Allow users to change specific other user volumes
* Screenshare does not cast audio
* Add audio pre-processing on the client for things like noise and echo cancellation, noise gate, and things like that
* Add emotes
* Highlight replies and mentions if the user is yourself
* Add notification icons to messages that have been unread