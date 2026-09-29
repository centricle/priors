for i in {1..32}; \
  do \
    stdout="$(claude --model haiku --effort low -p 'improve f7b3.html')" \
      && git commit -am $stdout \
      && open f7b3.html \
      && screencapture -R 0,120,1512,845 `echo $stdout | md5`.png \
      && git checkout 34d1261 -- f7b3.html \
  ; done