Attribute VB_Name = "DshLibAgent"
' Agent-initiated Word document operations (the mirror image of the AI task
' pump in DshLibCore): the dsh host enqueues commands (list / read / search /
' write / citePrepare / citeApply / maskShow) and THIS module's always-on
' OnTime pump claims them every ~3 s through /office/api/agent-poll, executes
' them in the running Word process and POSTs the outcome back to
' /office/api/agent-result.
'
' The busy mask ("maskShow") opens the DshLibBusyForm MODALLY, which blocks
' the Word UI while dsh is reading / editing. A WinAPI timer reenters VBA
' while the form is up (OnTime is frozen by the modal state) and polls
' /office/api/agent-mask-state, which both delivers further queued commands
' (so the agent keeps working behind the mask) and carries close/update
' instructions. The "terminate task" button POSTs /office/api/agent-mask-stop;
' the host then fails every pending command for this Word process AND cancels
' the dsh agent turn.
Option Explicit

#If VBA7 Then
    Private Declare PtrSafe Function DshLibAgentSetTimer Lib "user32" Alias "SetTimer" ( _
        ByVal hWnd As LongPtr, ByVal nIDEvent As LongPtr, ByVal uElapse As Long, ByVal lpTimerFunc As LongPtr) As LongPtr
    Private Declare PtrSafe Function DshLibAgentKillTimer Lib "user32" Alias "KillTimer" ( _
        ByVal hWnd As LongPtr, ByVal nIDEvent As LongPtr) As Long
    Private Declare PtrSafe Function DshLibAgentGetPid Lib "kernel32" Alias "GetCurrentProcessId" () As Long
    Private Declare PtrSafe Function DshLibAgentFindWindowW Lib "user32" Alias "FindWindowW" ( _
        ByVal lpClassName As LongPtr, ByVal lpWindowName As LongPtr) As LongPtr
    Private Declare PtrSafe Function DshLibAgentEnableWindow Lib "user32" Alias "EnableWindow" ( _
        ByVal hWnd As LongPtr, ByVal bEnable As Long) As Long
    Private Declare PtrSafe Function DshLibAgentPostMessageW Lib "user32" Alias "PostMessageW" ( _
        ByVal hWnd As LongPtr, ByVal Msg As Long, ByVal wParam As LongPtr, ByVal lParam As LongPtr) As Long
    Private Declare PtrSafe Function DshLibAgentIsWindow Lib "user32" Alias "IsWindow" ( _
        ByVal hWnd As LongPtr) As Long
    Private Declare PtrSafe Sub DshLibAgentSleep Lib "kernel32" Alias "Sleep" (ByVal ms As Long)
#Else
    Private Declare Function DshLibAgentSetTimer Lib "user32" Alias "SetTimer" ( _
        ByVal hWnd As Long, ByVal nIDEvent As Long, ByVal uElapse As Long, ByVal lpTimerFunc As Long) As Long
    Private Declare Function DshLibAgentKillTimer Lib "user32" Alias "KillTimer" ( _
        ByVal hWnd As Long, ByVal nIDEvent As Long) As Long
    Private Declare Function DshLibAgentGetPid Lib "kernel32" Alias "GetCurrentProcessId" () As Long
    Private Declare Function DshLibAgentFindWindowW Lib "user32" Alias "FindWindowW" ( _
        ByVal lpClassName As Long, ByVal lpWindowName As Long) As Long
    Private Declare Function DshLibAgentEnableWindow Lib "user32" Alias "EnableWindow" ( _
        ByVal hWnd As Long, ByVal bEnable As Long) As Long
    Private Declare Function DshLibAgentPostMessageW Lib "user32" Alias "PostMessageW" ( _
        ByVal hWnd As Long, ByVal Msg As Long, ByVal wParam As Long, ByVal lParam As Long) As Long
    Private Declare Function DshLibAgentIsWindow Lib "user32" Alias "IsWindow" ( _
        ByVal hWnd As Long) As Long
    Private Declare Sub DshLibAgentSleep Lib "kernel32" Alias "Sleep" (ByVal ms As Long)
#End If

' Debug: which section the failing command was in (surfaced in error text).
Private gDebugSection As String
' (ALL module-level declarations must precede the first procedure: VBA rejects
' anything but comments after End Sub / End Function / End Property.)
Private gAgentLastPollAt As Date
Private gAgentChains As Long       ' OnTime ticks scheduled but not fired
Private gAgentBusy As Boolean      ' reentrancy guard for the pump tick
Private gAgentTickCount As Long    ' debug: ticks fired
Private gAgentErrorCount As Long   ' debug: ticks that errored
Private gAgentLastError As String  ' debug: last error text
Private gAgentSchedules As Long    ' debug: Schedule() calls that armed a tick
Private gAgentScheduleFails As Long ' debug: OnTime calls that raised

' ------------------------------------------------------------ mask state
' The busy mask is a separate mshta.exe popup (a VBA MSForm cannot persist in
' a template built through COM), shown top-most while DshLibAgentEnableWindow
' blocks input to the Word main window. The OnTime pump keeps running and
' polls /office/api/agent-mask-state: it executes queued commands behind the
' mask, closes the popup on demand, and reports the maskShow result back.
Private gMaskActive As Boolean
Private gMaskStopRequested As Boolean
Private gMaskText As String
#If VBA7 Then
Private gPumpTimer As LongPtr     ' the always-on WinAPI pump timer
Private gMaskPopupHwnd As LongPtr
Private gMaskWordHwnd As LongPtr  ' THIS process' main window (locked during the mask)
Private gMaskRequestId As String   ' the deferred maskShow command result
Private gMaskTimer As LongPtr
#Else
Private gPumpTimer As Long
Private gMaskPopupHwnd As Long
Private gMaskWordHwnd As Long
Private gMaskRequestId As String   ' the deferred maskShow command result
Private gMaskTimer As Long
#End If

' Debug view for remote diagnosis (run via COM / immediate window).
Public Function DshLibAgentDebug() As String
    DshLibAgentDebug = "ticks=" & CStr(gAgentTickCount) & " errors=" & CStr(gAgentErrorCount) & _
        " lastError=" & gAgentLastError & " chains=" & CStr(gAgentChains) & _
        " schedules=" & CStr(gAgentSchedules) & " scheduleFails=" & CStr(gAgentScheduleFails) & _
        " lastPoll=" & CStr(gAgentLastPollAt) & " busy=" & CStr(gAgentBusy)
End Function

' ------------------------------------------------------------ localized text
Private Function DshLibAgentCap() As String
    DshLibAgentCap = DshLibCore.DshLibCN("44 53 48 6587 5E93 52A9 624B") ' DSH Library Assistant
End Function
Private Function DshLibAgentStopCaption() As String
    DshLibAgentStopCaption = DshLibCore.DshLibCN("7EC8 6B62 4EFB 52A1") ' Terminate task
End Function
Private Function DshLibAgentReadingText() As String
    DshLibAgentReadingText = DshLibCore.DshLibCN("6B63 5728 9605 8BFB 6587 6863 FF0C 8BF7 7A0D 5019 3002") ' Reading the document, please wait.
End Function
Private Function DshLibAgentStoppedText() As String
    DshLibAgentStoppedText = DshLibCore.DshLibCN("5DF2 7EC8 6B62 FF0C 6B63 5728 5173 95ED 3002") ' Terminated, closing.
End Function
Private Function DshLibAgentDocNotFound() As String
    DshLibAgentDocNotFound = DshLibCore.DshLibCN("672A 627E 5230 6307 5B9A 6587 6863") ' The specified document was not found
End Function
Private Function DshLibAgentParaRange() As String
    DshLibAgentParaRange = DshLibCore.DshLibCN("6BB5 843D 53F7 8D85 51FA 8303 56F4") ' Paragraph number out of range
End Function
Private Function DshLibAgentQueryNotFound() As String
    DshLibAgentQueryNotFound = DshLibCore.DshLibCN("672A 627E 5230 68C0 7D22 8BCD") ' Query text not found
End Function

' ---------------------------------------------------------------- pump

' Called from DshLibCore.AutoExec and DshLibRibbon.DshLibRibbonOnLoad at Word
' startup. Arms a WinAPI SetTimer callback as the PRIMARY pump driver (OnTime
' entries armed during template startup are silently dropped by Word in some
' sessions; a WM_TIMER callback survives) plus one OnTime chain as backup.
Public Sub DshLibAgentStartPump()
    On Error Resume Next
    gAgentLastPollAt = Now
    Call DshLibAgentArmTimer
    Call DshLibAgentSchedule
    On Error GoTo 0
End Sub

' WinAPI timer tick (WM_TIMER callback): drives the same tick as OnTime. The
' gAgentBusy guard makes double-firing harmless.
#If VBA7 Then
Public Sub DshLibAgentTimerProc(ByVal hWnd As LongPtr, ByVal uMsg As Long, ByVal idEvent As LongPtr, ByVal dwTime As Long)
#Else
Public Sub DshLibAgentTimerProc(ByVal hWnd As Long, ByVal uMsg As Long, ByVal idEvent As Long, ByVal dwTime As Long)
#End If
    On Error Resume Next
    Call DshLibAgentTick
    On Error GoTo 0
End Sub

Private Sub DshLibAgentArmTimer()
    On Error Resume Next
    If gPumpTimer = 0 Then
        gPumpTimer = DshLibAgentSetTimer(0, 0, 3000, AddressOf DshLibAgentTimerProc)
    End If
    On Error GoTo 0
End Sub

' Called from the ThisDocument event sink: revive a chain Word may have
' dropped (modal states, template reloads kill pending OnTime callbacks).
Public Sub DshLibAgentKeepAlive()
    On Error Resume Next
    If gMaskActive Then Exit Sub
    If gAgentChains <= 0 Or (gAgentLastPollAt > 0 And Now - gAgentLastPollAt > TimeSerial(0, 0, 20)) Then
        gAgentLastPollAt = Now
        Call DshLibAgentSchedule
    End If
    On Error GoTo 0
End Sub

Private Sub DshLibAgentSchedule()
    On Error Resume Next
    If gAgentChains > 2 Then Exit Sub
    gAgentChains = gAgentChains + 1
    Err.Clear
    Application.OnTime Now + TimeSerial(0, 0, 3), "DshLibAgentTick"
    If Err.Number <> 0 Then
        gAgentScheduleFails = gAgentScheduleFails + 1
        gAgentLastError = "OnTime: " & CStr(Err.Number) & " " & Err.Description
        gAgentChains = gAgentChains - 1
        If gAgentChains < 0 Then gAgentChains = 0
    Else
        gAgentSchedules = gAgentSchedules + 1
    End If
    On Error GoTo 0
End Sub

' One pump tick: heartbeat + claim + execute + report; mask duties while the
' busy mask is up. Invoked by BOTH the WinAPI timer and an OnTime chain; the
' gAgentBusy guard absorbs double-firing. Always re-arms the OnTime backup.
Public Sub DshLibAgentTick()
    On Error GoTo Done
    If gAgentBusy Then GoTo Done
    gAgentBusy = True
    gAgentChains = gAgentChains - 1
    If gAgentChains < 0 Then gAgentChains = 0
    gAgentTickCount = gAgentTickCount + 1
    gAgentLastPollAt = Now
    If gPumpTimer = 0 Then Call DshLibAgentArmTimer ' timer died: re-arm
    If gMaskActive Then
        Call DshLibAgentMaskStep
        GoTo Done
    End If

    ' Keep the AI write-back channel alive from this (reliable) WinAPI timer:
    ' Word silently drops the AI task's OnTime chain in some sessions, and the
    ' assistant's library_word_apply then waits out its 150 s window with the
    ' plan sitting in "ready" and nobody claiming it.
    Call DshLibCore.DshLibAiPollFromPump

    Dim port As Long
    port = DshLibCore.DshLibFindPort()
    If port = 0 Then GoTo Done
    Dim base As String
    base = "http://127.0.0.1:" & CStr(port)

    Dim req As Object
    Set req = CreateObject("Scripting.Dictionary")
    req.Add "pid", DshLibAgentGetPid()
    req.Add "docs", DshLibAgentDocList()
    Dim status As Long
    Dim responseText As String
    responseText = DshLibCore.DshLibHttpPostJson(base & "/office/api/agent-poll", JsonStringify(req), status)
    If status < 200 Or status >= 300 Then GoTo Done

    Dim parsed As Variant
    JsonParseInto responseText, parsed
    If Not IsObject(parsed) Then GoTo Done
    Dim commands As Variant
    Call JsonGetInto(parsed, "commands", commands)
    If IsNull(commands) Then GoTo Done

    Dim item As Variant
    For Each item In commands
        Call DshLibAgentExecute(base, item)
    Next item

Done:
    If Err.Number <> 0 Then
        gAgentErrorCount = gAgentErrorCount + 1
        gAgentLastError = "tick: " & CStr(Err.Number) & " " & Err.Description
    End If
    gAgentBusy = False
    Call DshLibAgentSchedule
End Sub

Private Function DshLibAgentDocList() As Variant
    Dim list As Variant
    Set list = JsonNewArray()
    On Error Resume Next
    Dim doc As Object
    For Each doc In Documents
        If Len(doc.FullName) > 0 Then
            list.Add doc.FullName
        Else
            list.Add doc.Name
        End If
    Next doc
    On Error GoTo 0
    Set DshLibAgentDocList = list
End Function

' Execute one claimed command and report the outcome. Never raises.
Private Sub DshLibAgentExecute(ByVal base As String, ByVal item As Variant)
    On Error GoTo Fail
    gDebugSection = "exec.init"
    Dim requestId As String
    Dim cmdType As String
    requestId = CStr(JsonGet(item, "requestId"))
    gDebugSection = "exec.type"
    cmdType = CStr(JsonGet(item, "type"))
    gDebugSection = "exec.args"
    Dim args As Variant
    Call JsonGetInto(item, "args", args)
    If IsNull(args) Then
        Set args = CreateObject("Scripting.Dictionary")
    ElseIf Not IsObject(args) Then
        Set args = CreateObject("Scripting.Dictionary")
    End If
    gDebugSection = "exec.dispatch"

    Dim value As Object
    Dim errText As String
    Dim ok As Boolean
    ok = DshLibAgentDispatch(cmdType, args, value, errText)
    If ok And cmdType = "maskShow" Then
        ' Deferred: the popup stays up for minutes; the result is posted when
        ' the mask closes (DshLibAgentFinishMask).
        gMaskRequestId = requestId
    ElseIf ok Then
        Call DshLibAgentPostResult(base, requestId, True, value, "")
    Else
        Call DshLibAgentPostResult(base, requestId, False, Nothing, errText)
    End If
    Exit Sub
Fail:
    Call DshLibAgentPostResult(base, requestId, False, Nothing, "VBA " & CStr(Err.Number) & "@" & gDebugSection & ": " & Err.Description)
End Sub

Private Sub DshLibAgentPostResult(ByVal base As String, ByVal requestId As String, ByVal ok As Boolean, ByVal value As Object, ByVal errText As String)
    On Error Resume Next
    Dim req As Object
    Set req = CreateObject("Scripting.Dictionary")
    req.Add "requestId", requestId
    If ok Then
        If value Is Nothing Then
            req.Add "ok", True
            req.Add "value", JsonObj()
        Else
            req.Add "ok", True
            req.Add "value", value
        End If
    Else
        req.Add "ok", False
        req.Add "error", errText
    End If
    Dim status As Long
    Call DshLibCore.DshLibHttpPostJson(base & "/office/api/agent-result", JsonStringify(req), status)
    On Error GoTo 0
End Sub

' ---------------------------------------------------------------- dispatch

Private Function DshLibAgentDispatch(ByVal cmdType As String, ByVal args As Object, ByRef value As Object, ByRef errText As String) As Boolean
    On Error GoTo Fail
    Select Case cmdType
        Case "maskShow"
            Dim stopped As Boolean
            stopped = DshLibAgentRunMask(args)
            Set value = JsonObj()
            value.Add "stopped", stopped
        Case Else
            ' Every other command needs a document (except "list").
            Dim doc As Object
            If cmdType = "list" Then
                Set value = DshLibAgentOpList()
            Else
                Set doc = DshLibAgentFindDoc(CStr(JsonGet(args, "docId")))
                gDebugSection = "findDoc"
                If doc Is Nothing Then
                    errText = DshLibAgentDocNotFound()
                    DshLibAgentDispatch = False
                    Exit Function
                End If
                Select Case cmdType
                    Case "read"
                        gDebugSection = "read"
                        Set value = DshLibAgentOpRead(doc, args)
                    Case "search"
                        gDebugSection = "search"
                        Set value = DshLibAgentOpSearch(doc, args)
                    Case "write"
                        gDebugSection = "write"
                        Set value = DshLibAgentOpWrite(doc, args)
                    Case "citePrepare"
                        gDebugSection = "citePrepare"
                        Set value = DshLibAgentOpCitePrepare(doc, args)
                    Case "citeApply"
                        gDebugSection = "citeApply"
                        Set value = DshLibAgentOpCiteApply(doc, args)
                    Case Else
                        errText = "unknown command: " & cmdType
                        DshLibAgentDispatch = False
                        Exit Function
                End Select
            End If
    End Select
    DshLibAgentDispatch = True
    Exit Function
Fail:
    errText = "VBA " & CStr(Err.Number) & "@" & gDebugSection & ": " & Err.Description
    DshLibAgentDispatch = False
End Function

Private Function DshLibAgentFindDoc(ByVal docId As String) As Object
    On Error Resume Next
    Set DshLibAgentFindDoc = Nothing
    If Len(docId) = 0 Then
        Set DshLibAgentFindDoc = ActiveDocument
        Exit Function
    End If
    Dim doc As Object
    For Each doc In Documents
        If StrComp(doc.FullName, docId, vbTextCompare) = 0 Then
            Set DshLibAgentFindDoc = doc
            Exit Function
        End If
    Next doc
    ' Unsaved blank documents carry only a NAME ("Document1"): match it too.
    For Each doc In Documents
        If StrComp(doc.Name, docId, vbTextCompare) = 0 Then
            Set DshLibAgentFindDoc = doc
            Exit Function
        End If
    Next doc
    ' Fall back to the file name (FullName may be empty for unsaved docs).
    If InStr(docId, "\") > 0 Or InStr(docId, "/") > 0 Then
        Dim shortName As String
        shortName = docId
        Do While InStr(shortName, "\") > 0
            shortName = Mid(shortName, InStr(shortName, "\") + 1)
        Loop
        For Each doc In Documents
            If StrComp(doc.Name, shortName, vbTextCompare) = 0 Then
                Set DshLibAgentFindDoc = doc
                Exit Function
            End If
        Next doc
    End If
    On Error GoTo 0
End Function

' ---------------------------------------------------------------- text helpers

' Strip paragraph / cell / line-break markers for plain reading.
Private Function DshLibAgentCleanText(ByVal s As String) As String
    Dim t As String
    t = s
    t = Replace(t, Chr(13), "")
    t = Replace(t, Chr(7), "")
    t = Replace(t, Chr(11), " ")
    t = Replace(t, Chr(12), " ")
    DshLibAgentCleanText = t
End Function

Private Function DshLibAgentParaIndexOf(ByVal doc As Object, ByVal para As Object) As Long
    On Error GoTo Fail
    DshLibAgentParaIndexOf = doc.Range(0, para.Range.End).Paragraphs.Count
    Exit Function
Fail:
    DshLibAgentParaIndexOf = 0
End Function

Private Function DshLibAgentDocStats(ByVal doc As Object, ByVal stats As Object)
    On Error Resume Next
    stats.Add "totalParas", doc.Paragraphs.Count
    stats.Add "totalChars", doc.Content.End - 1
    stats.Add "pages", doc.ComputeStatistics(2) ' wdStatisticPages
    On Error GoTo 0
End Function

' Collect paragraphs from..to (1-based, inclusive) into result. Caps the total
' characters at maxChars and reports the actually collected window.
Private Sub DshLibAgentCollectParas(ByVal doc As Object, ByVal fromPara As Long, ByVal toPara As Long, ByVal maxChars As Long, ByVal result As Object)
    Dim paras As Variant
    Set paras = JsonNewArray()
    Dim joined As String
    Dim total As Long
    total = doc.Paragraphs.Count
    Dim lastCollected As Long
    lastCollected = fromPara - 1
    Dim i As Long
    Dim chars As Long
    chars = 0
    Dim truncated As Boolean
    truncated = False
    For i = fromPara To toPara
        If i > total Then Exit For
        Dim para As Object
        Set para = doc.Paragraphs(i)
        Dim t As String
        t = DshLibAgentCleanText(para.Range.Text)
        If chars + Len(t) > maxChars And i > fromPara Then
            truncated = True
            Exit For
        End If
        Dim entry As Object
        Set entry = JsonObj()
        entry.Add "n", i
        entry.Add "text", t
        paras.Add entry
        If Len(joined) > 0 Then joined = joined & vbCr
        joined = joined & t
        chars = chars + Len(t)
        lastCollected = i
    Next i
    result.Add "fromPara", fromPara
    result.Add "toPara", lastCollected
    result.Add "paras", paras
    result.Add "text", joined
    result.Add "truncated", truncated
End Sub

' Resolve a search hit inside doc to its paragraph index (0 when not found).
Private Function DshLibAgentFindHitPara(ByVal doc As Object, ByVal query As String) As Long
    On Error GoTo Fail
    Dim rng As Object
    Set rng = doc.Content
    Dim find As Object
    Set find = rng.Find
    find.ClearFormatting
    find.Text = query
    find.Forward = True
    find.Wrap = 0 ' wdFindStop
    find.MatchCase = False
    If find.Execute Then
        DshLibAgentFindHitPara = DshLibAgentParaIndexOf(doc, rng.Paragraphs(1))
    Else
        DshLibAgentFindHitPara = 0
    End If
    Exit Function
Fail:
    DshLibAgentFindHitPara = 0
End Function

Private Function DshLibAgentGetLong(ByVal args As Object, ByVal key As String, ByVal def As Long) As Long
    Dim v As Variant
    v = JsonGet(args, key)
    ' VBA does NOT short-circuit: IsEmpty(Null) itself raises error 94, so the
    ' null check must come first and bail before IsEmpty ever sees a Null.
    If IsNull(v) Then
        DshLibAgentGetLong = def
    ElseIf IsEmpty(v) Then
        DshLibAgentGetLong = def
    Else
        On Error Resume Next
        DshLibAgentGetLong = CLng(v)
        If Err.Number <> 0 Then
            Err.Clear
            DshLibAgentGetLong = def
        End If
        On Error GoTo 0
    End If
End Function

Private Function DshLibAgentGetStr(ByVal args As Object, ByVal key As String, ByVal def As String) As String
    Dim v As Variant
    v = JsonGet(args, key)
    ' Same no-short-circuit trap as DshLibAgentGetLong.
    If IsNull(v) Then
        DshLibAgentGetStr = def
    ElseIf IsEmpty(v) Then
        DshLibAgentGetStr = def
    Else
        DshLibAgentGetStr = CStr(v)
    End If
End Function

' ---------------------------------------------------------------- ops

Private Function DshLibAgentOpList() As Object
    Dim result As Object
    Set result = JsonObj()
    Dim docs As Variant
    Set docs = JsonNewArray()
    Dim doc As Object
    For Each doc In Documents
        Dim entry As Object
        Set entry = JsonObj()
        On Error Resume Next
        Dim docId As String
        docId = doc.FullName
        If Len(docId) = 0 Then docId = doc.Name ' unsaved blank document
        entry.Add "docId", docId
        entry.Add "name", doc.Name
        entry.Add "pages", doc.ComputeStatistics(2)
        entry.Add "totalParas", doc.Paragraphs.Count
        entry.Add "totalChars", doc.Content.End - 1
        entry.Add "saved", doc.Saved
        entry.Add "readOnly", doc.ReadOnly
        entry.Add "active", (doc.Name = ActiveDocument.Name)
        On Error GoTo 0
        docs.Add entry
    Next doc
    result.Add "docs", docs
    result.Add "pid", DshLibAgentGetPid()
    Set DshLibAgentOpList = result
End Function

' args: docId, page? | para?+paras?/toPara? | query?+contextParas?, maxChars?
Private Function DshLibAgentOpRead(ByVal doc As Object, ByVal args As Object) As Object
    gDebugSection = "read.init"
    Dim result As Object
    Set result = JsonObj()
    result.Add "docId", doc.FullName
    result.Add "name", doc.Name
    gDebugSection = "read.stats"
    Call DshLibAgentDocStats(doc, result)
    gDebugSection = "read.args"
    Dim maxChars As Long
    maxChars = DshLibAgentGetLong(args, "maxChars", 12000)
    If maxChars < 500 Then maxChars = 500
    If maxChars > 40000 Then maxChars = 40000

    Dim page As Long
    Dim para As Long
    Dim fromPara As Long
    Dim toPara As Long
    page = DshLibAgentGetLong(args, "page", 0)
    para = DshLibAgentGetLong(args, "para", 0)
    Dim query As String
    query = DshLibAgentGetStr(args, "query", "")
    Dim contextParas As Long
    contextParas = DshLibAgentGetLong(args, "contextParas", 2)
    If contextParas < 0 Then contextParas = 0
    If contextParas > 10 Then contextParas = 10

    If page > 0 Then
        ' The paragraph window covering that page.
        Dim startRange As Object
        Set startRange = doc.GoTo(1, 1, page) ' wdGoToPage, wdGoToAbsolute
        fromPara = DshLibAgentParaIndexOf(doc, startRange.Paragraphs(1))
        Dim endStart As Long
        endStart = doc.Content.End
        On Error Resume Next
        Dim nextRange As Object
        Set nextRange = doc.GoTo(1, 1, page + 1)
        If Not nextRange Is Nothing Then endStart = nextRange.Start
        Err.Clear
        On Error GoTo 0
        If endStart >= doc.Content.End Then
            toPara = doc.Paragraphs.Count
        Else
            toPara = DshLibAgentParaIndexOf(doc, doc.Range(0, endStart).Paragraphs(1)) - 1
            If toPara < fromPara Then toPara = fromPara
        End If
    ElseIf para > 0 Then
        Dim count As Long
        count = DshLibAgentGetLong(args, "paras", 0)
        Dim toGiven As Long
        toGiven = DshLibAgentGetLong(args, "toPara", 0)
        If toGiven > 0 Then
            fromPara = para
            toPara = toGiven
        Else
            If count <= 0 Then count = 30
            fromPara = para
            toPara = para + count - 1
        End If
    ElseIf Len(query) > 0 Then
        Dim hit As Long
        hit = DshLibAgentFindHitPara(doc, query)
        If hit = 0 Then
            Err.Raise vbObjectError + 901, , DshLibAgentQueryNotFound()
        End If
        fromPara = hit - contextParas
        toPara = hit + contextParas
    Else
        ' Whole document, from the beginning.
        fromPara = 1
        toPara = DshLibAgentGetLong(args, "paras", 0)
        If toPara <= 0 Then toPara = 40 Else toPara = toPara
    End If
    If fromPara < 1 Then fromPara = 1
    Dim total As Long
    total = doc.Paragraphs.Count
    If fromPara > total Then
        Err.Raise vbObjectError + 902, , DshLibAgentParaRange()
    End If
    If toPara > total Then toPara = total
    gDebugSection = "read.collect"
    Call DshLibAgentCollectParas(doc, fromPara, toPara, maxChars, result)
    Set DshLibAgentOpRead = result
End Function

' args: docId, query, maxHits?, contextParas?
Private Function DshLibAgentOpSearch(ByVal doc As Object, ByVal args As Object) As Object
    Dim result As Object
    Set result = JsonObj()
    result.Add "docId", doc.FullName
    result.Add "name", doc.Name
    Dim query As String
    query = DshLibAgentGetStr(args, "query", "")
    Dim maxHits As Long
    maxHits = DshLibAgentGetLong(args, "maxHits", 20)
    If maxHits < 1 Then maxHits = 1
    If maxHits > 50 Then maxHits = 50
    Dim contextParas As Long
    contextParas = DshLibAgentGetLong(args, "contextParas", 1)
    If contextParas < 0 Then contextParas = 0
    If contextParas > 10 Then contextParas = 10

    Dim hits As Variant
    Set hits = JsonNewArray()
    Dim total As Long
    total = doc.Paragraphs.Count
    If Len(query) > 0 And total > 0 Then
        Dim rng As Object
        Set rng = doc.Content
        Dim find As Object
        Set find = rng.Find
        find.ClearFormatting
        find.Forward = True
        find.Wrap = 0
        find.MatchCase = False
        find.Text = query
        Dim guard As Long
        guard = 0
        Dim lastEnd As Long
        lastEnd = -1
        Do While find.Execute And guard < 200
            guard = guard + 1
            If rng.Start >= lastEnd Then
                lastEnd = rng.End
                Dim hitPara As Long
                hitPara = DshLibAgentParaIndexOf(doc, rng.Paragraphs(1))
                Dim fromPara As Long
                Dim toPara As Long
                fromPara = hitPara - contextParas
                If fromPara < 1 Then fromPara = 1
                toPara = hitPara + contextParas
                If toPara > total Then toPara = total
                Dim windowResult As Object
                Set windowResult = JsonObj()
                Call DshLibAgentCollectParas(doc, fromPara, toPara, 4000, windowResult)
                Dim hit As Object
                Set hit = JsonObj()
                hit.Add "para", hitPara
                hit.Add "match", DshLibAgentCleanText(rng.Text)
                hit.Add "fromPara", fromPara
                hit.Add "toPara", toPara
                hit.Add "text", windowResult("text")
                hits.Add hit
                If hits.Count >= maxHits Then Exit Do
            Else
                Exit Do
            End If
        Loop
    End If
    result.Add "query", query
    result.Add "hits", hits
    result.Add "count", hits.Count
    Set DshLibAgentOpSearch = result
End Function

' args: docId, mode=replaceParas|insertAfter|append, para/fromPara?, toPara?, text
Private Function DshLibAgentOpWrite(ByVal doc As Object, ByVal args As Object) As Object
    Dim text As String
    text = DshLibAgentGetStr(args, "text", "")
    If Len(text) = 0 Then
        Err.Raise vbObjectError + 903, , "text is empty"
    End If
    Dim mode As String
    mode = DshLibAgentGetStr(args, "mode", "replaceParas")

    Dim total As Long
    total = doc.Paragraphs.Count
    Dim fromPara As Long
    Dim toPara As Long
    fromPara = DshLibAgentGetLong(args, "para", 0)
    If fromPara = 0 Then fromPara = DshLibAgentGetLong(args, "fromPara", 0)
    toPara = DshLibAgentGetLong(args, "toPara", 0)

    Dim screenSaved As Boolean
    Dim undoStarted As Boolean
    On Error GoTo Restore
    screenSaved = False
    undoStarted = False
    Application.ScreenUpdating = False
    screenSaved = True
    If Val(Application.Version) >= 14 Then
        On Error Resume Next
        Application.UndoRecord.StartCustomRecord "DSH"
        If Err.Number = 0 Then undoStarted = True
        Err.Clear
        On Error GoTo Restore
    End If

    Dim result As Object
    Set result = JsonObj()
    result.Add "docId", doc.FullName
    result.Add "mode", mode

    If mode = "replaceParas" Then
        If fromPara < 1 Or fromPara > total Then
            Err.Raise vbObjectError + 902, , DshLibAgentParaRange()
        End If
        If toPara < fromPara Then toPara = fromPara
        If toPara > total Then toPara = total
        Dim rng As Object
        Set rng = doc.Range(doc.Paragraphs(fromPara).Range.Start, doc.Paragraphs(toPara).Range.End)
        Dim newText As String
        newText = Replace(text, vbCr & vbCr, vbCr) ' keep it simple: \n from JSON arrives as \r already
        If toPara < total Then
            If Right(newText, 1) <> vbCr Then newText = newText & vbCr
        Else
            Do While Right(newText, 1) = vbCr And Len(newText) > 0
                newText = Left(newText, Len(newText) - 1)
            Loop
        End If
        rng.Text = newText
        result.Add "replacedFrom", fromPara
        result.Add "replacedTo", toPara
    ElseIf mode = "insertAfter" Then
        If fromPara < 1 Or fromPara > total Then
            Err.Raise vbObjectError + 902, , DshLibAgentParaRange()
        End If
        Dim insertText As String
        insertText = text
        If fromPara >= total Then
            ' Last paragraph: start a new paragraph at the document end.
            Dim endRng As Object
            Set endRng = doc.Range(doc.Content.End - 1, doc.Content.End - 1)
            If Right(insertText, 1) = vbCr Then insertText = Left(insertText, Len(insertText) - 1)
            endRng.Text = vbCr & insertText
        Else
            Dim afterStart As Long
            afterStart = doc.Paragraphs(fromPara).Range.End
            Dim afterRng As Object
            Set afterRng = doc.Range(afterStart, afterStart)
            If Right(insertText, 1) <> vbCr Then insertText = insertText & vbCr
            afterRng.Text = insertText
        End If
        result.Add "insertedAfter", fromPara
    ElseIf mode = "append" Then
        Dim appendText As String
        appendText = text
        If Right(appendText, 1) = vbCr Then appendText = Left(appendText, Len(appendText) - 1)
        Dim tail As Object
        Set tail = doc.Range(doc.Content.End - 1, doc.Content.End - 1)
        tail.Text = vbCr & appendText
        result.Add "appended", True
    Else
        Err.Raise vbObjectError + 904, , "unknown mode: " & mode
    End If

    result.Add "totalParas", doc.Paragraphs.Count
    Set DshLibAgentOpWrite = result

Restore:
    Dim savedNumber As Long
    Dim savedDescription As String
    savedNumber = Err.Number
    savedDescription = Err.Description
    On Error Resume Next
    If undoStarted Then Application.UndoRecord.EndCustomRecord
    If screenSaved Then Application.ScreenUpdating = True
    On Error GoTo 0
    If savedNumber <> 0 Then Err.Raise savedNumber, , savedDescription
End Function

' args: docId, para? | query?  -> capture the paragraph Range as the citation
' anchor and report its visible text (the host validates citations against it).
Private Function DshLibAgentOpCitePrepare(ByVal doc As Object, ByVal args As Object) As Object
    Dim para As Long
    para = DshLibAgentGetLong(args, "para", 0)
    Dim query As String
    query = DshLibAgentGetStr(args, "query", "")
    Dim target As Object
    Set target = Nothing
    If para > 0 Then
        If para > doc.Paragraphs.Count Then
            Err.Raise vbObjectError + 902, , DshLibAgentParaRange()
        End If
        Set target = doc.Paragraphs(para).Range
    ElseIf Len(query) > 0 Then
        Dim rng As Object
        Set rng = doc.Content
        Dim find As Object
        Set find = rng.Find
        find.ClearFormatting
        find.Text = query
        find.Forward = True
        find.Wrap = 0
        find.MatchCase = False
        If find.Execute Then
            Set target = rng.Paragraphs(1).Range
        Else
            Err.Raise vbObjectError + 905, , "query not found: " & query
        End If
    Else
        Err.Raise vbObjectError + 906, , "para or query required"
    End If
    ' Drop the trailing paragraph mark: the apply machinery compares and
    ' anchors on visible text only.
    If target.End > target.Start Then
        If Right(target.Text, 1) = vbCr Or Right(target.Text, 1) = Chr(7) Then
            target.End = target.End - 1
        End If
    End If
    If Len(target.Text) = 0 Then
        Err.Raise vbObjectError + 907, , "empty target paragraph"
    End If
    If Not DshLibFields.DshLibAiSetRange(target, doc.Name) Then
        Err.Raise vbObjectError + 908, , "could not capture range"
    End If
    Dim result As Object
    Set result = JsonObj()
    result.Add "docId", doc.FullName
    result.Add "para", DshLibAgentParaIndexOf(doc, target.Paragraphs(1))
    result.Add "text", target.Text
    Set DshLibAgentOpCitePrepare = result
End Function

' args: docId, taskId -> run the regular applyAiEdit transaction against the
' Range captured by citePrepare. The real outcome flows back to the waiting
' agent tool through the AI task registry; we only report that we tried.
Private Function DshLibAgentOpCiteApply(ByVal doc As Object, ByVal args As Object) As Object
    Dim taskId As String
    taskId = DshLibAgentGetStr(args, "taskId", "")
    If Len(taskId) = 0 Then
        Err.Raise vbObjectError + 909, , "taskId required"
    End If
    If Not DshLibFields.DshLibAiActive() And DshLibFields.DshLibAiTaskId() <> "" Then
        Err.Raise vbObjectError + 910, , "citePrepare state lost (run citePrepare again)"
    End If
    ' The apply transaction must identify the document with EXACTLY the same
    ' docId string the host used for routing (blank unsaved docs: the NAME,
    ' not the empty FullName) or beginApply's pid+docId check fails.
    Dim txnDocId As String
    txnDocId = DshLibAgentGetStr(args, "docId", "")
    If Len(txnDocId) = 0 Then txnDocId = doc.FullName
    ' Register the task FIRST: DshLibAiActive requires a non-empty taskId,
    ' which citePrepare (range capture only) deliberately left blank.
    Call DshLibFields.DshLibAiSetTask(taskId, txnDocId)
    If DshLibFields.DshLibAiRangeText() = "" Then
        Err.Raise vbObjectError + 911, , "citePrepare range lost (run citePrepare again)"
    End If
    Call DshLibCore.DshLibAiRunApply(True) ' quiet: errors go back to dsh, never MsgBox
    Dim result As Object
    Set result = JsonObj()
    result.Add "docId", txnDocId
    result.Add "taskId", taskId
    Set DshLibAgentOpCiteApply = result
End Function

' ---------------------------------------------------------------- busy mask
' The mask is a separate mshta.exe popup: VBA stays fully alive (OnTime keeps
' ticking, commands execute behind the mask), the Word main window's input is
' disabled with EnableWindow, and the popup's single button closes it - which
' the pump reads back as the user stopping the task.

Private Function DshLibAgentRunMask(ByVal args As Object) As Boolean
    On Error Resume Next
    Dim text As String
    text = DshLibAgentGetStr(args, "text", "")
    If Len(text) = 0 Then text = DshLibAgentReadingText()
    gMaskText = text
    gMaskStopRequested = False
    Dim existing As LongPtr
    existing = DshLibAgentFindBusyHwnd()
    Dim file As String
    file = Environ("TEMP") & "\dsh-busy-mask-" & CStr(DshLibAgentGetPid()) & ".hta"
    Call DshLibAgentWriteMaskHtml(file, text)
    Dim wsh As Object
    Set wsh = CreateObject("WScript.Shell")
    wsh.Run """mshta.exe"" """ & file & """", 1, False
    Dim hwnd As LongPtr
    Dim tries As Long
    Do
        Call DshLibAgentSleep(120)
        hwnd = DshLibAgentFindBusyHwnd()
        tries = tries + 1
    Loop While (hwnd = 0 Or hwnd = existing) And tries < 40
    If hwnd <> 0 And hwnd <> existing Then gMaskPopupHwnd = hwnd Else gMaskPopupHwnd = 0
    ' Lock THIS Word process' main window (ActiveWindow.Hwnd belongs to us;
    ' FindWindow would return whatever Word instance is topmost, and several
    ' WINWORD.EXE processes may be running).
    gMaskWordHwnd = 0
    On Error Resume Next
    gMaskWordHwnd = ActiveWindow.Hwnd
    Err.Clear
    On Error GoTo 0
    If gMaskWordHwnd = 0 Then gMaskWordHwnd = DshLibAgentFindWindowW(StrPtr("OpusApp"), 0)
    If gMaskWordHwnd <> 0 Then DshLibAgentEnableWindow gMaskWordHwnd, 0
    gMaskActive = True
    ' The maskShow result is DEFERRED: it is posted when the mask closes.
    DshLibAgentRunMask = False
    On Error GoTo 0
End Function

' Locate the busy popup by its (unique) window title. The class name differs
' between mshta versions ("HTML Application Host Window Class" vs the legacy
' "HTML Application Popup"), the title is ours and stable.
#If VBA7 Then
Private Function DshLibAgentFindBusyHwnd() As LongPtr
#Else
Private Function DshLibAgentFindBusyHwnd() As Long
#End If
    On Error Resume Next
    DshLibAgentFindBusyHwnd = DshLibAgentFindWindowW(0, StrPtr("DSH Library Busy"))
    On Error GoTo 0
End Function

' UTF-8 HTML for the popup: status text + the single "terminate task" button.
Private Sub DshLibAgentWriteMaskHtml(ByVal file As String, ByVal text As String)
    Dim t As String
    t = text
    t = Replace(t, "&", "&amp;")
    t = Replace(t, "<", "&lt;")
    t = Replace(t, ">", "&gt;")
    Dim html As String
    html = "<html><head><meta http-equiv=""Content-Type"" content=""text/html;charset=utf-8""><title>DSH Library Busy</title>" & _
        "<hta:application id=""oApp"" border=""dialog"" borderstyle=""normal"" caption=""yes"" maximizebutton=""no"" minimizebutton=""no"" sysmenu=""yes"" scroll=""no"" innerborder=""no"" navigable=""no""/>" & _
        "<style>html,body{margin:0;background:#202124;color:#f1f3f4;font-family:'Segoe UI',sans-serif}</style></head><body scroll=""no"">" & _
        "<div style=""padding:26px 30px 8px;font-size:15px;line-height:1.7;max-width:440px"">" & t & "</div>" & _
        "<div style=""padding:10px 30px 22px""><button onclick=""window.close()"" style=""font-size:14px;padding:8px 24px;cursor:pointer"">" & _
        DshLibAgentStopCaption() & "</button></div>" & _
        "<script>window.resizeTo(560,260);window.moveTo((screen.width-560)/2,140);</script></body></html>"
    Dim bytes() As Byte
    bytes = DshLibCore.DshLibUtf8Encode(html)
    Dim stream As Object
    Set stream = CreateObject("ADODB.Stream")
    stream.Type = 1 ' binary
    stream.Open
    stream.Write bytes
    stream.SaveToFile file, 2 ' adSaveCreateOverWrite
    stream.Close
End Sub

' Pump duties while the mask is up: execute queued commands behind the mask,
' detect the popup being killed by the user, close on demand.
Private Sub DshLibAgentMaskStep()
    On Error GoTo Fail
    ' Popup killed from outside (Alt+F4 / task manager) counts as a stop.
    If gMaskPopupHwnd <> 0 And DshLibAgentIsWindow(gMaskPopupHwnd) = 0 Then
        gMaskStopRequested = True
        Call DshLibAgentReportStop
        Call DshLibAgentFinishMask
        Exit Sub
    End If
    Dim port As Long
    port = DshLibCore.DshLibFindPort()
    If port = 0 Then Exit Sub
    Dim base As String
    base = "http://127.0.0.1:" & CStr(port)

    Dim req As Object
    Set req = CreateObject("Scripting.Dictionary")
    req.Add "pid", DshLibAgentGetPid()
    Dim status As Long
    Dim responseText As String
    responseText = DshLibCore.DshLibHttpPostJson(base & "/office/api/agent-mask-state", JsonStringify(req), status)
    If status < 200 Or status >= 300 Then Exit Sub

    Dim parsed As Variant
    JsonParseInto responseText, parsed
    If Not IsObject(parsed) Then Exit Sub

    ' JsonGetInto (NOT Set x = JsonGet): a missing key returns Null and
    ' "Set x = Null" raises an error that would swallow the close handling.
    Dim commands As Variant
    Call JsonGetInto(parsed, "commands", commands)
    If Not IsNull(commands) Then
        Dim item As Variant
        For Each item In commands
            Call DshLibAgentExecute(base, item)
        Next item
    End If

    If JsonGet(parsed, "close") = True Then
        If JsonGet(parsed, "stopped") = True Then gMaskStopRequested = True
        Call DshLibAgentFinishMask
    End If
    Exit Sub
Fail:
    On Error Resume Next
    On Error GoTo 0
End Sub

' Tear the mask down: close the popup, re-enable Word input, post the deferred
' maskShow result back to the host.
Private Sub DshLibAgentFinishMask()
    On Error Resume Next
    If gMaskPopupHwnd <> 0 Then
        If DshLibAgentIsWindow(gMaskPopupHwnd) <> 0 Then
            Call DshLibAgentPostMessageW(gMaskPopupHwnd, 16, 0, 0) ' WM_CLOSE
        End If
        gMaskPopupHwnd = 0
    End If
    If gMaskWordHwnd <> 0 Then
        If DshLibAgentIsWindow(gMaskWordHwnd) <> 0 Then
            Call DshLibAgentEnableWindow(gMaskWordHwnd, 1)
        End If
        gMaskWordHwnd = 0
    End If
    If Len(gMaskRequestId) > 0 Then
        Dim port As Long
        port = DshLibCore.DshLibFindPort()
        If port <> 0 Then
            Dim value As Object
            Set value = JsonObj()
            value.Add "stopped", gMaskStopRequested
            Call DshLibAgentPostResult("http://127.0.0.1:" & CStr(port), gMaskRequestId, True, value, "")
        End If
    End If
    gMaskRequestId = ""
    gMaskActive = False
    gMaskStopRequested = False
    gMaskText = ""
    On Error GoTo 0
End Sub

' The popup was closed by the USER (button or Alt+F4): tell the host to stop
' every pending command of this Word process AND cancel the dsh agent turn.
Private Sub DshLibAgentReportStop()
    On Error Resume Next
    Dim port As Long
    port = DshLibCore.DshLibFindPort()
    If port = 0 Then Exit Sub
    Dim req As Object
    Set req = CreateObject("Scripting.Dictionary")
    req.Add "pid", DshLibAgentGetPid()
    Dim status As Long
    Call DshLibCore.DshLibHttpPostJson("http://127.0.0.1:" & CStr(port) & "/office/api/agent-mask-stop", JsonStringify(req), status)
    On Error GoTo 0
End Sub
