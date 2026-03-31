BUGS
* Archive chats that occur when unfriending occurs or choose to archive a chat. maybe right click menu for a lot of the information in the DMs page like unfriending and archiving and such.

* Voice talking status should be more apparent when someone is talking as opposed to green when quiet, and slightly green aura when talking.

* Message button on user popup icon is not centered horizontally, and the text is not centered vertically.

* If someone screenshares, and then another user selects to watch, and then the original user shares video, it asks again to watch but for both, despite the  fact that the other user was already watching the screenshare.
* This setting seems to persist when it shouldnt, since if i click watch but the streaming user turns off and on, it will auto join. Can we also have a leave screenshare button? maybe int eh right click menu fo the screenshare?
* Audio effects don't work, but at the very least threshold looks like it's working locally. Actually the threshold worked upon rejoining?
* Audio slider volume for other users in a voice chat doesn't do anything past 200


QOL Stuff
* Screenshare should cast audio
* Add audio pre-processing on the client for things like noise and echo cancellation, noise gate, and things like that
* Highlight replies and mentions if the user is yourself
* Add notification icons to messages that have been unread, and a different color if mentioned
* Update friend UI to not accidentally remove friends.
* be able to right click on names in the voice channels for kick and audio and such

* Have a voice audio preview so you can hear yourself post effects.
* Show loudness when speaking on the threshold meter if noise gate is enabled.
* Add emotes with :emote: commands, like :smiley: and such.
* Use tab and Enter to cycle through/enter names when using emotes with :stuff: syntax, and for @name pings. 

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