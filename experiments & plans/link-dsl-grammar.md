
```
line     := <link-part> ( " " "!" option )*
link-part:= plain URL | "- " URL | [Title](URL)   (existing formats, unchanged)
option   := cmd [ "=" value ]          bare cmd (no "=") means true
cmd      := any prefix of a full command, at least the minimum:
            ta(gs) to(pics) f(avourite) d(one) r(esources) c(lean) w(eeks)
value    := array | bool | int
array    := "[" item ("," item)* "]"   items whitespace-trimmed; "\," = literal comma
bool     := true | 1 | yes | false | 0 | no
```