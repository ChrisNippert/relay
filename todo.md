# BUGS

* Images in encrypted channels are not encrypted
* Sometimes image upload fails with html 413 error: <html> <head><title>413 Request Entity Too Large</title></head> <body> <center><h1>413 Request Entity Too Large</h1></center> <hr><center>nginx/1.24.0 (Ubuntu)</center> </body> </html>, and subsequent uploads take infinitely long. For reference the file is 9MB, so not at the limit. Switching channels seems to reset the infinite upload issue
* Can't join from another device to replace current voice chat join (maybe)
* When passing a file over the main window and going to some other window, it pops up "drop files here" and doesn't go away until i leave the servers page.
* Sometimes when people join a voice chat, I get calling notifications
* WebRTC Calls over DMs don't work at all. They seem to instantly end when trying to join.

* When clicking on a server with notifs in the main channel, they don't act as read until i switch channels and go back to the autoselected channel

# QOL Stuff
* When selecting a channel/selecting a server auto joining a channel, put the cursor in the chat message box so I can start typing immediately
* Improve audio pre-processing effects to mute things like keyboard, mouse clicks, and background noise


# UI QOL
* DM Notifications should pop up 


# TODOs later
<!-- * Somehow the messages section is still too far over to the side. Can you find somewhere else that this problem is and fix it since everywhere youve fixed before hasn't changed it, and the redesign still has the problem persist. -->
<!-- * Screenshare should cast audio. Watching on qpw graph, when I watch a stream no new inputs show up still! Im on firefox i guess if you need that information -->
<!-- * e2ee sometimes decryption fails? operation error is the error occurring but switching channels seemed to fix the issue until new messages are sent, in which case they are failing again. Images say decryption failed too but still display the image. -->
<!-- * When e2ee, make it so when a new device joins, it sends a message in the chat requesting keys and whoever presses the button generates keys for that user so new devices only get old keys when allowed. This can also be done by clicking on a user in the members page when in a text channel and clicking on a button with something like "send old keys" or something. -->
<!-- * Optional e2ee in DMs (Same mechanism for ease) -->
<!-- * Look into Web transport instead of webrtc maybe? idk webrtc only does peer to peer. -->
* Make sure user registration info is securely stored
* Use turn instead of stun for servers since webrtc doesn't like VPNs apparently
* Make A mobile web version

# Done
* Show user mute/deafen/screenshare/camera status in the voice chat sidebar and on the voice chat screen.
* User can choose mono or stereo for voice calls
* Separate camera and video feeds as two separate cards on the voice channel page instead of having it tiny and in the corner.
* Add Emojis
* Make watching people's streams or video feeds optional in the voice channel page.
* Allow users to change specific other user volumes
* Voice talking status should be more apparent when someone is talking as opposed to green when quiet, and slightly green aura when talking.
* Update friend UI to not accidentally remove friends.
* Add audio pre-processing on the client for things like noise and echo cancellation, noise gate, and things like that
* Add emotes with :emote: commands, like :smiley: and such.
* Use tab and Enter to cycle through/enter names when using emotes with :stuff: syntax, and for @name pings. 
* Highlight replies and mentions if the user is yourself
* Add notification icons to messages that have been unread, and a different color if mentioned
* When muted, the green light still shows up in the voice channel.
* The threshold works sometimes but refresh needed occasionally
* Audio slider volume for other users in a voice chat doesn't do anything past 100
* If im watching the screenshare, and the user then turns on their camera, it will auto watch the camera as well.
* Allow users to change streaming resolution, 360, 480, 720, 1080, 2k and Framerate 15, 30, 60, 120 (if possible)
* Make fullscreen mode completely fullscreen with things like the unfullscreen and disconnect buttons only pop up when mouse near the top or bottom of the pane so its completely fullscreen.
* Make the user list in the voice channel sidebar feel like buttons that I could right click
* The shrink members button doesn't appear on the voice chat page. please make this happen 
* Server bar notificaions
* Change server bar on the left to be names instead of squares to be less like discord. Also for new DMs, show the name beneath the DM tab, but above all the servers.

* names in voice channel sideview move when lighting up since it grows and it's left aligned. Make it so it grows but does not move the text.
* For sometimes the noise gate threshold test microphone doesn't show a green bar. Can we always show the green bar even without the test microphone on?

* Take server out of login screen for now until we want to do federation
* Along with this, make users not have images or circles since we won't have profile pictures. It's supposed to have that old IRC/forum aesthetic