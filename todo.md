BUGS
<!-- * Somehow the messages section is still too far over to the side. Can you find somewhere else that this problem is and fix it since everywhere youve fixed before hasn't changed it, and the redesign still has the problem persist. -->
<!-- * Screenshare should cast audio. Watching on qpw graph, when I watch a stream no new inputs show up still! Im on firefox i guess if you need that information -->
* For some reason camera and screenshare has latency and freezes up sometimes. Is this something that can be fixed here?

QOL Stuff
* Improve audio pre-processing effects to mute things like keyboard, mouse clicks, and background noise

TODOs later
<!-- * Look into Web transport instead of webrtc maybe? idk webrtc only does peer to peer. -->
* Make sure user registration info is securely stored
* Use turn instead of stun for servers since webrtc doesn't like VPNs apparently

E2EE
* Implement spec listed in protocol
* E2EE still doesn't work. New clients rotate key when sending a message but don't seem to get the old keys.

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