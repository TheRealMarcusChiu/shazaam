# Concat

ffmpeg -f concat -safe 0 -i list.txt -c copy output.mp3

# Mix

523.25 Hz
659.25 Hz
783.99 Hz



ffmpeg -i 523.251-hz.mp3 -i 659.25-hz.mp3 -i 783.99-hz.mp3 \
-filter_complex "amix=inputs=3:duration=longest:dropout_transition=2" \
-c:a mp3 c-major-chord.mp3