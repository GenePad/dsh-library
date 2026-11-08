Attribute VB_Name = "DshLibCore"
' Word-side client for the dsh library writing plugin.
'
' The host (Node) implements DshLibCore's Integration.execCommand engine and speaks
' DshLibCore's HTTP integration protocol. This module is the transport layer:
'   POST /connector/document/execCommand  {"command": <user cmd>, "docId": ...}
'   -> response is the next {"command": "...", "arguments": [...]} instruction
'   -> DshLibFields.Dispatch executes it and its JSON result becomes the body of
'      POST /connector/document/respond, whose response is the next instruction
'   -> repeat until "Document.complete"
'
' There is deliberately no WM_COPYDATA / COM automation of the dsh host: a
' synchronous MSXML2.ServerXMLHTTP.6.0 loop is all that is needed.
Option Explicit

Private Const PORT_FIRST As Long = 23119
Private Const PORT_LAST As Long = 23128
Private Const API_VERSION As String = "3"

Private gUndoStarted As Boolean
Private gScreenSaved As Boolean
Private gScreenUpdating As Boolean

' ---------------------------------------------------------------- helpers

' Decode a space separated run of 4-hex-digit UTF-16 code units into a String.
' Keeps every user visible Chinese string out of the .bas source bytes so the
' VBE import (which reads .bas as ANSI) can never corrupt them.
Public Function DshLibCN(ByVal hex As String) As String
    Dim parts() As String
    Dim out As String
    Dim i As Long
    Dim j As Long
    Dim v As Long
    Dim d As Long
    Dim c As String
    parts = Split(Trim$(hex), " ")
    For i = LBound(parts) To UBound(parts)
        If Len(parts(i)) = 4 Then
            v = 0
            For j = 1 To 4
                c = UCase$(Mid$(parts(i), j, 1))
                d = InStr("0123456789ABCDEF", c) - 1
                If d < 0 Then d = 0
                v = v * 16 + d
            Next j
            out = out & ChrW$(v)
        End If
    Next i
    DshLibCN = out
End Function

Private Function DshLibMsgTitle() As String
    DshLibMsgTitle = DshLibCN("6587 5E93 5F15 7528")   ' dsh library citation plugin
End Function

Private Function DshLibMsgNotFound() As String
    DshLibMsgNotFound = DshLibCN("672A 627E 5230 8FD0 884C 4E2D 7684 6587 5E93 63D2 4EF6 670D 52A1 FF0C 8BF7 5148 542F 52A8") _
        & " dsh " & _
        DshLibCN("5E76 5728 8BBE 7F6E 4E2D 786E 8BA4 5199 4F5C 63D2 4EF6 670D 52A1 5DF2 8FD0 884C")
End Function

Private Function DshLibMsgNetworkError() As String
    DshLibMsgNetworkError = DshLibCN("65E0 6CD5 8FDE 63A5 6587 5E93 63D2 4EF6 670D 52A1 FF0C 64CD 4F5C 5DF2 53D6 6D88")
End Function

Public Function DshLibMsgCommandFail() As String
    DshLibMsgCommandFail = DshLibCN("0057 006F 0072 0064 0020 7AEF 547D 4EE4 6267 884C 5931 8D25")
End Function

' ---------------------------------------------------------------- entries

Public Sub DshLibAddEditCitation()
    Call DshLibCommand("addEditCitation", True)
End Sub

Public Sub DshLibInsertCitation()
    Call DshLibCommand("addCitation", True)
End Sub

Public Sub DshLibEditCitation()
    Call DshLibCommand("editCitation", True)
End Sub

Public Sub DshLibAddEditBibliography()
    Call DshLibCommand("addEditBibliography", True)
End Sub

Public Sub DshLibInsertBibliography()
    Call DshLibCommand("addBibliography", False)
End Sub

Public Sub DshLibEditBibliography()
    Call DshLibCommand("editBibliography", True)
End Sub

Public Sub DshLibSetDocPrefs()
    Call DshLibCommand("setDocPrefs", True)
End Sub

Public Sub DshLibRefresh()
    Call DshLibCommand("refresh", False)
End Sub

Public Sub DshLibRemoveCodes()
    Call DshLibCommand("removeCodes", False)
End Sub

Public Sub DshLibCitationExplorer()
    Call DshLibCommand("citationExplorer", True)
End Sub

' ---------------------------------------------------------------- undo record

Public Sub DshLibEndUndoRecord()
    On Error Resume Next
    If gUndoStarted Then
        Application.UndoRecord.EndCustomRecord
        gUndoStarted = False
    End If
    On Error GoTo 0
End Sub

Public Sub DshLibRestoreScreenUpdating()
    On Error Resume Next
    If gScreenSaved Then
        Application.ScreenUpdating = gScreenUpdating
        gScreenSaved = False
    End If
    On Error GoTo 0
End Sub

' ---------------------------------------------------------------- HTTP

Private Function DshLibPingOK(ByVal port As Long) As Boolean
    On Error GoTo Fail
    Dim http As Object
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.setTimeouts 1000, 1000, 2000, 2000
    http.Open "GET", "http://127.0.0.1:" & CStr(port) & "/connector/ping", False
    http.setRequestHeader "X-DshLibCore-Connector-API-Version", API_VERSION
    http.send
    ' Only accept OUR service. Port 23119 is also DshLibCore's own connector
    ' port: if a real DshLibCore is running there, its ping also returns 200 and
    ' the transaction would be sent to the wrong host.
    If http.Status = 200 Then
        Dim pingReply As String
        pingReply = DshLibUtf8Decode(http.ResponseBody)
        DshLibPingOK = (InStr(1, pingReply, """processorName"":""Word""", vbBinaryCompare) > 0)
    Else
        DshLibPingOK = False
    End If
    Exit Function
Fail:
    DshLibPingOK = False
End Function

Private Function DshLibFindPort() As Long
    Dim p As Long
    For p = PORT_FIRST To PORT_LAST
        If DshLibPingOK(p) Then
            DshLibFindPort = p
            Exit Function
        End If
    Next p
    DshLibFindPort = 0
End Function

' Synchronous JSON POST. Returns the response body decoded from UTF-8; status
' is filled with the HTTP status (0 on a transport failure).
Private Function DshLibHttpPostJson(ByVal url As String, ByVal body As String, ByRef status As Long) As String
    On Error GoTo Fail
    Dim http As Object
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.setTimeouts 5000, 5000, 15000, 120000
    http.Open "POST", url, False
    http.setRequestHeader "Content-Type", "application/json; charset=utf-8"
    http.setRequestHeader "X-DshLibCore-Connector-API-Version", API_VERSION
    ' JsonStringify emits pure ASCII (non-ASCII becomes \uXXXX), so sending the
    ' BSTR directly is safe regardless of MSXML's string encoding.
    If Len(body) = 0 Then
        http.send
    Else
        http.send body
    End If
    status = http.Status
    DshLibHttpPostJson = DshLibUtf8Decode(http.ResponseBody)
    Exit Function
Fail:
    status = 0
    DshLibHttpPostJson = ""
End Function

' Decode a UTF-8 byte array (MSXML ResponseBody) into a UTF-16 VBA String.
' Preferred: ADODB.Stream with an explicit utf-8 charset; fallback: a pure-VBA
' UTF-8 decoder so the client still works when ADO is unavailable.
Public Function DshLibUtf8Decode(ByVal bytes As Variant) As String
    Dim b() As Byte
    Dim n As Long
    On Error Resume Next
    b = bytes
    n = UBound(b) - LBound(b) + 1
    If Err.Number <> 0 Or n <= 0 Then
        Err.Clear
        DshLibUtf8Decode = ""
        Exit Function
    End If
    On Error GoTo 0
    On Error GoTo Manual
    Dim stm As Object
    Set stm = CreateObject("ADODB.Stream")
    stm.Type = 1                          ' adTypeBinary
    stm.Open
    stm.Write b
    stm.Position = 0
    stm.Type = 2                          ' adTypeText
    stm.Charset = "utf-8"
    DshLibUtf8Decode = stm.ReadText(-1)
    stm.Close
    Exit Function
Manual:
    On Error Resume Next
    DshLibUtf8Decode = DshLibDecodeUtf8Bytes(b)
End Function

' Encode a UTF-16 VBA String as UTF-8 bytes (for temp RTF/HTML files).
Public Function DshLibUtf8Encode(ByVal s As String) As Byte()
    Dim out() As Byte
    Dim i As Long
    Dim cp As Long
    Dim n As Long
    Dim lo As Long
    ReDim out(1 To Len(s) * 4 + 4)
    n = 0
    For i = 1 To Len(s)
        cp = AscW(Mid$(s, i, 1))
        If cp < 0 Then cp = cp + 65536
        If cp < &H80 Then
            n = n + 1
            out(n) = CByte(cp)
        ElseIf cp < &H800 Then
            n = n + 1
            out(n) = CByte(&HC0 + (cp \ &H40))
            n = n + 1
            out(n) = CByte(&H80 + (cp And &H3F))
        ElseIf cp >= &HD800 And cp <= &HDBFF Then
            If i < Len(s) Then
                lo = AscW(Mid$(s, i + 1, 1))
                If lo < 0 Then lo = lo + 65536
                If lo >= &HDC00 And lo <= &HDFFF Then
                    cp = &H10000 + (cp - &HD800) * &H400 + (lo - &HDC00)
                    i = i + 1
                End If
            End If
            If cp >= &H10000 Then
                n = n + 1
                out(n) = CByte(&HF0 + (cp \ &H40000))
                n = n + 1
                out(n) = CByte(&H80 + ((cp \ &H1000) And &H3F))
                n = n + 1
                out(n) = CByte(&H80 + ((cp \ &H40) And &H3F))
                n = n + 1
                out(n) = CByte(&H80 + (cp And &H3F))
            Else
                n = n + 1
                out(n) = CByte(&HE0 + (cp \ &H1000))
                n = n + 1
                out(n) = CByte(&H80 + ((cp \ &H40) And &H3F))
                n = n + 1
                out(n) = CByte(&H80 + (cp And &H3F))
            End If
        Else
            n = n + 1
            out(n) = CByte(&HE0 + (cp \ &H1000))
            n = n + 1
            out(n) = CByte(&H80 + ((cp \ &H40) And &H3F))
            n = n + 1
            out(n) = CByte(&H80 + (cp And &H3F))
        End If
    Next i
    If n = 0 Then
        ReDim out(1 To 1)
        out(1) = 0
    Else
        ReDim Preserve out(1 To n)
    End If
    DshLibUtf8Encode = out
End Function

Private Function DshLibDecodeUtf8Bytes(b() As Byte) As String
    Dim out As String
    Dim i As Long
    Dim n As Long
    Dim c As Long
    Dim cp As Long
    Dim hi As Long
    Dim lo As Long
    i = LBound(b)
    n = UBound(b)
    If n - i + 1 >= 3 Then
        If b(i) = &HEF And b(i + 1) = &HBB And b(i + 2) = &HBF Then i = i + 3
    End If
    Do While i <= n
        c = b(i)
        If c < &H80 Then
            out = out & ChrW$(c)
            i = i + 1
        ElseIf (c And &HE0) = &HC0 Then
            If i + 1 <= n Then
                cp = ((c And &H1F) * &H40) + (b(i + 1) And &H3F)
                out = out & ChrW$(cp)
            End If
            i = i + 2
        ElseIf (c And &HF0) = &HE0 Then
            If i + 2 <= n Then
                cp = ((c And &HF) * &H1000) + ((b(i + 1) And &H3F) * &H40) + (b(i + 2) And &H3F)
                out = out & ChrW$(cp)
            End If
            i = i + 3
        ElseIf (c And &HF8) = &HF0 Then
            If i + 3 <= n Then
                cp = ((c And &H7) * &H40000) + ((b(i + 1) And &H3F) * &H1000) _
                    + ((b(i + 2) And &H3F) * &H40) + (b(i + 3) And &H3F)
                cp = cp - &H10000
                hi = &HD800 + (cp \ &H400)
                lo = &HDC00 + (cp And &H3FF)
                out = out & ChrW$(hi) & ChrW$(lo)
            End If
            i = i + 4
        Else
            i = i + 1
        End If
    Loop
    DshLibDecodeUtf8Bytes = out
End Function

' Post an {"error":"Alert",...} body to /respond (the host turns it into an
' exception) so a VBA failure never leaves Word hung inside a transaction.
Private Sub DshLibPostAlertRespond(ByVal base As String, ByVal message As String, ByVal stack As String)
    On Error Resume Next
    Dim d As Object
    Set d = CreateObject("Scripting.Dictionary")
    d.Add "error", "Alert"
    d.Add "message", message
    d.Add "stack", stack
    Dim st As Long
    Dim ignored As String
    ignored = DshLibHttpPostJson(base & "/connector/document/respond", JsonStringify(d), st)
    On Error GoTo 0
End Sub

' ---------------------------------------------------------------- transaction

Public Sub DshLibCommand(cmd As String, bringToFront As Boolean)
    Dim base As String
    Dim port As Long
    Dim docId As String
    Dim body As String
    Dim status As Long
    Dim responseText As String
    Dim instruction As Variant
    Dim commandName As String
    Dim arguments As Variant
    Dim result As Variant
    Dim respondBody As String
    Dim loopCount As Long
    Dim errNum As Long
    Dim errDesc As String
    Dim req As Object
    Dim dummy As Variant
    ' bringToFront is kept for API parity; with an HTTP host there is no
    ' DshLibCore window to foreground, so it is intentionally unused.

    On Error GoTo Fatal
    port = DshLibFindPort()
    If port = 0 Then
        MsgBox DshLibMsgNotFound(), vbExclamation, DshLibMsgTitle()
        Exit Sub
    End If
    base = "http://127.0.0.1:" & CStr(port)

    docId = ActiveDocument.FullName
    If Len(docId) = 0 Then docId = ActiveDocument.Name

    ' One undo record and one screen-updating switch for the whole transaction.
    gScreenUpdating = Application.ScreenUpdating
    gScreenSaved = True
    Application.ScreenUpdating = False
    gUndoStarted = False
    If Val(Application.Version) >= 14 Then
        On Error Resume Next
        Application.UndoRecord.StartCustomRecord DshLibCN("6587 5E93 5F15 7528 547D 4EE4")
        If Err.Number = 0 Then gUndoStarted = True
        Err.Clear
        On Error GoTo Fatal
    End If

    Set req = CreateObject("Scripting.Dictionary")
    req.Add "command", cmd
    req.Add "docId", docId
    body = JsonStringify(req)
    responseText = DshLibHttpPostJson(base & "/connector/document/execCommand", body, status)
    If status < 200 Or status >= 300 Then
        Err.Raise vbObjectError + 100, , "execCommand HTTP " & CStr(status)
    End If

    Do While Len(Trim$(responseText)) > 0
        loopCount = loopCount + 1
        If loopCount > 2000 Then Err.Raise vbObjectError + 101, , "too many commands"

        JsonParseInto responseText, instruction
        If IsNull(instruction) Or IsEmpty(instruction) Then
            DshLibPostAlertRespond base, DshLibMsgCommandFail() & ": invalid instruction JSON", "DshLibCommand/JsonParse"
            Exit Do
        End If
        If Not IsObject(instruction) Then
            DshLibPostAlertRespond base, DshLibMsgCommandFail() & ": instruction is not an object", "DshLibCommand/JsonParse"
            Exit Do
        End If
        commandName = CStr(JsonGet(instruction, "command"))
        If Len(commandName) = 0 Then
            DshLibPostAlertRespond base, DshLibMsgCommandFail() & ": missing command name", "DshLibCommand/JsonParse"
            Exit Do
        End If
        JsonGetInto instruction, "arguments", arguments
        If IsNull(arguments) Or IsEmpty(arguments) Then Set arguments = New Collection

        If commandName = "Document.complete" Then
            ' Let Dispatch close the undo record, then stop without a respond:
            ' the server has already ended its side of the transaction.
            DshLibFields.DispatchInto commandName, arguments, docId, dummy
            Exit Do
        End If

        On Error GoTo DispatchFail
        DshLibFields.DispatchInto commandName, arguments, docId, result
        On Error GoTo Fatal

        If IsObject(result) Then
            If JsonHas(result, "__dshError") Then
                respondBody = CStr(JsonGet(result, "message"))
                errDesc = CStr(JsonGet(result, "stack"))
                DshLibPostAlertRespond base, respondBody, errDesc
                Exit Do
            End If
        End If
        respondBody = JsonStringify(result)
        responseText = DshLibHttpPostJson(base & "/connector/document/respond", respondBody, status)
        If status < 200 Or status >= 300 Then
            Err.Raise vbObjectError + 102, , "respond HTTP " & CStr(status)
        End If
    Loop
    GoTo Cleanup

DispatchFail:
    errNum = Err.Number
    errDesc = Err.Description
    DshLibPostAlertRespond base, DshLibMsgCommandFail() & ": " & errDesc, "DshLibCommand/" & commandName & " Err " & CStr(errNum)
    GoTo Cleanup

Fatal:
    On Error Resume Next
    MsgBox DshLibMsgNetworkError() & " (" & CStr(Err.Number) & ")", vbCritical, DshLibMsgTitle()
    On Error GoTo 0
    ' fall through to Cleanup

Cleanup:
    On Error Resume Next
    DshLibFields.TransactionCleanup docId
    DshLibRestoreScreenUpdating
    DshLibEndUndoRecord
    ' The bibliography count may have changed (insert / unlink / refresh);
    ' re-evaluate the greyed-out state of the insert-bibliography button.
    DshLibRibbon.DshLibRibbonInvalidate
    On Error GoTo 0
End Sub
