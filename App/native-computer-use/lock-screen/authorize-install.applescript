on run arguments
  if (count of arguments) is not 2 then error "Invalid Memmy lock authorization request"
  set installerPath to item 1 of arguments
  set requestedAction to item 2 of arguments
  if requestedAction is not "install" and requestedAction is not "uninstall" then error "Invalid Memmy lock authorization action"
  do shell script quoted form of installerPath & " " & quoted form of requestedAction with administrator privileges
end run
