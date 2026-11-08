Attribute VB_Name = "DshLibFields"
' Core responder for the dsh HTTP integration commands.
'
' Every Document.* / Field.* / Application.* instruction is dispatched here and
' answered with a Variant that JsonStringify can serialize. The field collection
' lives in a module level Dictionary for the duration of one DshLibCommand macro
' call, so field ids issued by getFields/insertField stay resolvable.
'
' Field code conventions (matching the DshLibCore C++ integration):
'   Field mode   : Word field code text = " ADDIN ZOTERO_" & code & " "
'                 (client-layer code, e.g. "ITEM CSL_CITATION {...}", "TEMP")
'                 Legacy " CSL_" prefix is also accepted when reading.
'   Bookmark mode: bookmark name = "ZOTERO_BREF_" & 12 random chars,
'                 code stored in CustomDocumentProperties under that name as
'                 "ZOTERO_" & code (chunked into _1/_2/... pieces of <=255).
'   Document data: CustomDocumentProperties "ZOTERO_PREF", chunked the same way.
Option Explicit
Option Compare Binary

' ---------------------------------------------------------------- constants

Private Const FIELD_PREFIX As String = " ADDIN ZOTERO_"
Private Const FIELD_PREFIX_LEGACY As String = " CSL_"
Private Const BOOKMARK_PREFIX As String = "ZOTERO_BREF_"
Private Const BOOKMARK_CODE_PREFIX As String = "ZOTERO_"
Private Const BOOKMARK_CODE_PREFIX_LEGACY As String = "CSL_"
Private Const PREFS_PROPERTY As String = "ZOTERO_PREF"
Private Const FIELD_PLACEHOLDER As String = "{Citation}"
Private Const PLACEHOLDER_URL As String = "https://www.zotero.org/"
Private Const EXPORT_MARKER As String = "ZOTERO_TRANSFER_DOCUMENT"
Private Const EXPORT_MARKER_LEGACY As String = "ZOTERO_EXPORTED_DOCUMENT"
Private Const DEFAULT_DOC_DATA As String = "<data data-version=""3""/>"
Private Const IMPORT_ITEM_PREFIX As String = "ITEM CSL_CITATION "
Private Const IMPORT_BIBL_PREFIX As String = "BIBL "
Private Const IMPORT_DOC_PREFS_PREFIX As String = "DOCUMENT_PREFERENCES "
Private Const IMPORT_BIBSTYLE_PREFIX As String = "BIBLIOGRAPHY_STYLE "
Private Const MAX_PROPERTY_LENGTH As Long = 255
Private Const NOTE_OFFSET As Double = 100000000

Private Const wdFieldQuote As Long = 35
Private Const wdCollapseEnd As Long = 0
Private Const wdCollapseStart As Long = 1
Private Const wdCharacter As Long = 1
Private Const wdParagraph As Long = 4
Private Const wdMainTextStory As Long = 1
Private Const wdFootnotesStory As Long = 2
Private Const wdEndnotesStory As Long = 3
Private Const wdLineSpaceExactly As Long = 4
Private Const msoPropertyTypeString As Long = 4

' ---------------------------------------------------------------- state

Private gFields As Object            ' Dictionary: id -> info Dictionary
Private gOrder As Collection         ' ids in document order
Private gNextId As Long
Private gTempFiles As Collection
Private gTempCounter As Long
Private gShowRevisions As Boolean
Private gShowRevisionsSaved As Boolean
Private gDocId As String
Private gInited As Boolean

' AI task state (SURVIVES transactions): the selection Range captured when the
' user clicked the Word AI button plus the host-assigned task id. Word Range
' objects stay live across edits, so the write-back can happen minutes later.
Private gAiTaskId As String
Private gAiDocId As String
Private gAiDocName As String
Private gAiRange As Object           ' the captured selection Range
Private gAiWorking As Object         ' collapsed insertion cursor (replace mode)

' ---------------------------------------------------------------- public API

Public Function Dispatch(ByVal command As String, ByRef args As Variant, ByVal docId As String) As Variant
    Dim result As Variant
    DispatchInto command, args, docId, result
    If IsObject(result) Then
        Set Dispatch = result
    Else
        Dispatch = result
    End If
End Function

' Fill a ByRef Variant with the result. DshLibCore.bas uses this so object results
' are never subject to Let-coercion of a function return value.
Public Sub DispatchInto(ByVal command As String, ByRef args As Variant, ByVal docId As String, ByRef result As Variant)
    Dim method As String
    Dim dotPos As Long
    On Error GoTo Failed
    result = Null
    EnsureTransaction docId

    dotPos = InStrRev(command, ".")
    If dotPos > 0 Then
        method = Mid$(command, dotPos + 1)
    Else
        method = command
    End If

    Select Case method
        Case "getActiveDocument": CmdGetActiveDocument args, result
        Case "activate": CmdActivate args, result
        Case "canInsertField": CmdCanInsertField args, result
        Case "displayAlert": CmdDisplayAlert args, result
        Case "getDocumentData": CmdGetDocumentData args, result
        Case "setDocumentData": CmdSetDocumentData args, result
        Case "setBibliographyStyle": CmdSetBibliographyStyle args, result
        Case "insertText": CmdInsertText args, result
        Case "getFields": CmdGetFields args, result
        Case "cursorInField": CmdCursorInField args, result
        Case "insertField": CmdInsertField args, result
        Case "convert": CmdConvert args, result
        Case "convertPlaceholdersToFields": CmdConvertPlaceholdersToFields args, result
        Case "importDocument": CmdImportDocument args, result
        Case "exportDocument": CmdExportDocument args, result
        Case "cleanup": CmdCleanup args, result
        Case "complete": CmdComplete args, result
        Case "delete": CmdFieldDelete args, result
        Case "select": CmdFieldSelect args, result
        Case "removeCode": CmdFieldRemoveCode args, result
        Case "setText": CmdFieldSetText args, result
        Case "setCode": CmdFieldSetCode args, result
        Case "getText": CmdFieldGetText args, result
        Case "getCode": CmdFieldGetCode args, result
        Case "getNoteIndex": CmdFieldGetNoteIndex args, result
        Case "equals": CmdFieldEquals args, result
        Case "isAdjacentToNextField": CmdFieldIsAdjacent args, result
        Case "aiBegin": CmdAiBegin args, result
        Case "aiText": CmdAiText args, result
        Case "aiField": CmdAiField args, result
        Case "aiFieldAt": CmdAiFieldAt args, result
        Case "aiEnd": CmdAiEnd args, result
        Case Else
            ' Unknown command: answer null rather than hanging the transaction.
            result = Null
    End Select
    Exit Sub
Failed:
    Set result = MakeError(Err.Number, Err.Description, command)
End Sub

' Full reset, called by DshLibCommand when the transaction loop ends.
Public Sub TransactionCleanup(ByVal docId As String)
    RestoreEnvironment
    Set gFields = CreateObject("Scripting.Dictionary")
    Set gOrder = New Collection
    gNextId = 1
    gInited = False
    DshLibCore.DshLibEndUndoRecord
End Sub

' True while the active document already carries a bibliography, in either the
' field (" ADDIN ZOTERO_BIBL ...") or the bookmark (ZOTERO_BREF_* property
' starting "BIBL ") representation. Feeds the Ribbon getEnabled callback for
' the insert-bibliography button; purely local, never talks to the host.
Public Function DshLibDocHasBibliography() As Boolean
    Dim fld As Object
    Dim bm As Object
    Dim code As String
    On Error Resume Next
    For Each fld In ActiveDocument.Content.Fields
        If InStr(fld.Code.Text, "ZOTERO_BIBL") > 0 Then
            DshLibDocHasBibliography = True
            Exit Function
        End If
    Next fld
    For Each bm In ActiveDocument.Bookmarks
        If Left$(bm.Name, Len(BOOKMARK_PREFIX)) = BOOKMARK_PREFIX Then
            code = ClientCodeFromBookmarkValue(PropGet(bm.Name))
            If Left$(code, Len(IMPORT_BIBL_PREFIX)) = IMPORT_BIBL_PREFIX Then
                DshLibDocHasBibliography = True
                Exit Function
            End If
        End If
    Next bm
    On Error GoTo 0
End Function

' ---------------------------------------------------------------- AI tasks

' Capture the current selection as the AI write-back target. The Range is
' duplicated so later selection changes cannot detach it; the document name
' lets the apply re-activate exactly this document. Returns False when the
' selection vanished between the click and this call.
Public Function DshLibAiCapture(ByVal docName As String) As Boolean
    On Error GoTo Fail
    If Selection Is Nothing Then DshLibAiCapture = False: Exit Function
    If Selection.Start = Selection.End Then DshLibAiCapture = False: Exit Function
    Set gAiRange = Selection.Range.Duplicate
    gAiDocName = ActiveDocument.Name
    gAiTaskId = ""
    gAiDocId = ""
    Set gAiWorking = Nothing
    DshLibAiCapture = True
    Exit Function
Fail:
    DshLibAiCapture = False
End Function

Public Sub DshLibAiSetTask(ByVal taskId As String, ByVal docId As String)
    gAiTaskId = taskId
    gAiDocId = docId
End Sub

Public Function DshLibAiTaskId() As String
    DshLibAiTaskId = gAiTaskId
End Function

Public Function DshLibAiDocId() As String
    DshLibAiDocId = gAiDocId
End Function

Public Function DshLibAiActive() As Boolean
    DshLibAiActive = (Len(gAiTaskId) > 0) And (Not gAiRange Is Nothing)
End Function

Public Function DshLibAiDocOpen() As Boolean
    Dim doc As Object
    On Error Resume Next
    Set doc = Nothing
    If Len(gAiDocName) > 0 Then Set doc = Documents(gAiDocName)
    DshLibAiDocOpen = Not doc Is Nothing
    If Err.Number <> 0 Then DshLibAiDocOpen = False
    On Error GoTo 0
End Function

' Make the captured document the active one so the apply transaction's
' Document.* commands hit the right document even when the user has switched
' to another document in the SAME Word process meanwhile.
Public Function DshLibAiActivateDoc() As Boolean
    On Error Resume Next
    If Len(gAiDocName) = 0 Then DshLibAiActivateDoc = False: Exit Function
    Documents(gAiDocName).Activate
    DshLibAiActivateDoc = (ActiveDocument.Name = gAiDocName)
    If Err.Number <> 0 Then
        Err.Clear
        DshLibAiActivateDoc = False
    End If
    On Error GoTo 0
End Function

Public Sub DshLibAiClear()
    Set gAiRange = Nothing
    Set gAiWorking = Nothing
    gAiTaskId = ""
    gAiDocId = ""
    gAiDocName = ""
End Sub

' Whitespace-insensitive comparison of the live range text with the text the
' host recorded at task start. The round trip through JSON preserves every
' other character exactly, so any difference means the user edited the passage
' after starting the task and the write-back must be refused.
Private Function DshLibAiSameText(ByVal current As String, ByVal expected As String) As Boolean
    DshLibAiSameText = (DshLibAiStripWs(current) = DshLibAiStripWs(expected))
End Function

Private Function DshLibAiStripWs(ByVal s As String) As String
    Dim out As String
    Dim i As Long
    Dim c As String
    For i = 1 To Len(s)
        c = Mid$(s, i, 1)
        Select Case c
            Case " ", vbCr, vbLf, vbTab, Chr$(11), Chr$(12), Chr$(160)
            Case Else
                out = out & c
        End Select
    Next i
    DshLibAiStripWs = out
End Function

Private Function DshLibAiErrText() As String
    DshLibAiErrText = DshLibCore.DshLibCN("9009 533A 5185 5BB9 5DF2 53D8 5316 FF0C 5199 56DE 5DF2 53D6 6D88 FF0C 8BF7 5728 0057 006F 0072 0064 4E2D 91CD 65B0 9009 4E2D 8BE5 6BB5 540E 91CD 8BD5")
End Function

Private Function DshLibAiErrNotBody() As String
    DshLibAiErrNotBody = DshLibCore.DshLibCN("9009 533A 4E0D 5728 6B63 6587 4E2D FF08 8868 683C 002F 9875 7709 002F 811A 6CE8 6682 4E0D 652F 6301 FF09")
End Function

Private Sub CmdAiBegin(args As Variant, ByRef result As Variant)
    Dim mode As String
    Dim expected As String
    Dim current As String
    Dim d As Object
    On Error GoTo Failed
    Set d = CreateObject("Scripting.Dictionary")
    If gAiRange Is Nothing Then
        d.Add "ok", False
        d.Add "error", "aiBegin: no captured selection"
        Set result = d
        Exit Sub
    End If
    If gAiRange.StoryType <> wdMainTextStory Then
        d.Add "ok", False
        d.Add "error", DshLibAiErrNotBody()
        Set result = d
        Exit Sub
    End If
    mode = ArgStr(args, 2, "replace")
    expected = ArgStr(args, 3, "")
    current = gAiRange.Text
    If Len(expected) > 0 Then
        If Not DshLibAiSameText(current, expected) Then
            d.Add "ok", False
            d.Add "error", DshLibAiErrText()
            Set result = d
            Exit Sub
        End If
    End If
    d.Add "ok", True
    d.Add "original", current
    If mode = "insert" Then
        Set gAiWorking = gAiRange.Duplicate
    Else
        gAiRange.Text = ""
        Set gAiWorking = gAiRange.Duplicate
        gAiWorking.Collapse wdCollapseStart
    End If
    Set result = d
    Exit Sub
Failed:
    Set d = CreateObject("Scripting.Dictionary")
    d.Add "ok", False
    d.Add "error", "aiBegin failed: " & Err.Description
    Set result = d
End Sub

Private Sub CmdAiText(args As Variant, ByRef result As Variant)
    On Error GoTo Failed
    If gAiWorking Is Nothing Then Err.Raise vbObjectError + 210, , "aiText: no working range"
    gAiWorking.Text = ArgStr(args, 2, "")
    gAiWorking.Collapse wdCollapseEnd
    result = Null
    Exit Sub
Failed:
    Set result = MakeError(Err.Number, Err.Description, "Document.aiText")
End Sub

Private Sub CmdAiField(args As Variant, ByRef result As Variant)
    Dim info As Object
    Dim afterPos As Long
    Dim fieldType As String
    On Error GoTo Failed
    If gAiWorking Is Nothing Then Err.Raise vbObjectError + 211, , "aiField: no working range"
    fieldType = NormalizeFieldType(ArgStr(args, 2, "Field"))
    Set info = CreateFieldAt(gAiWorking.Duplicate, fieldType, 0)
    If info Is Nothing Then
        result = Null
        Exit Sub
    End If
    RegisterNewField info, result
    ' Move the insertion cursor past the new field. Field-mode ranges include
    ' the field markers ({ }), bookmark mode does not.
    afterPos = CLng(info("rangeEnd"))
    If Len(CStr(info("bookmark"))) = 0 Then afterPos = afterPos - 1
    gAiWorking.SetRange afterPos, afterPos
    Exit Sub
Failed:
    Set result = MakeError(Err.Number, Err.Description, "Document.aiField")
End Sub

' Insert-mode: create a citation field at a character offset INSIDE the
' original (still intact) selection. The host applies offsets in descending
' order, so earlier insertions never shift the remaining ones.
Private Sub CmdAiFieldAt(args As Variant, ByRef result As Variant)
    Dim offset As Long
    Dim fieldType As String
    Dim noteType As Integer
    Dim pos As Long
    Dim rng As Object
    Dim info As Object
    On Error GoTo Failed
    If gAiRange Is Nothing Then Err.Raise vbObjectError + 212, , "aiFieldAt: no captured range"
    offset = CLng(ArgNum(args, 2, 0))
    fieldType = NormalizeFieldType(ArgStr(args, 3, "Field"))
    noteType = CInt(ArgNum(args, 4, 0))
    pos = CLng(gAiRange.Start) + offset
    Set rng = ActiveDocument.Range(pos, pos)
    Set info = CreateFieldAt(rng, fieldType, noteType)
    If info Is Nothing Then
        result = Null
        Exit Sub
    End If
    RegisterNewField info, result
    Exit Sub
Failed:
    Set result = MakeError(Err.Number, Err.Description, "Document.aiFieldAt")
End Sub

Private Sub CmdAiEnd(args As Variant, ByRef result As Variant)
    Set gAiWorking = Nothing
    result = Null
End Sub

' ---------------------------------------------------------------- arg helpers

Private Function ArgStr(args As Variant, ByVal index As Long, ByVal def As String) As String
    Dim v As Variant
    v = JsonArg(args, index, def)
    If IsNull(v) Or IsEmpty(v) Then
        ArgStr = def
    ElseIf IsObject(v) Then
        ArgStr = def
    Else
        ArgStr = CStr(v)
    End If
End Function

Private Function ArgNum(args As Variant, ByVal index As Long, ByVal def As Double) As Double
    Dim v As Variant
    v = JsonArg(args, index, def)
    If IsNull(v) Or IsEmpty(v) Then
        ArgNum = def
    ElseIf IsObject(v) Then
        ArgNum = def
    Else
        ArgNum = Val(CStr(v))
    End If
End Function

' Read a boolean argument. JSON booleans arrive as VBA Boolean ("True"/"False"),
' which Val()/ArgNum() silently turn into 0. Never coerce a flag through
' ArgNum: Field.setText(isRich) would then always take the plain-text branch
' and write citeproc's RTF markup literally into the document.
Private Function ArgBool(args As Variant, ByVal index As Long, ByVal def As Boolean) As Boolean
    Dim v As Variant
    Dim s As String
    v = JsonArg(args, index, def)
    If IsNull(v) Or IsEmpty(v) Or IsObject(v) Then
        ArgBool = def
    ElseIf VarType(v) = vbBoolean Then
        ArgBool = CBool(v)
    ElseIf IsNumeric(v) Then
        ArgBool = (CDbl(v) <> 0)
    Else
        s = LCase$(Trim$(CStr(v)))
        ArgBool = (s = "true" Or s = "1" Or s = "-1" Or s = "yes")
    End If
End Function

Private Function NormalizeFieldType(ByVal s As String) As String
    If InStr(1, LCase$(s), "bookmark", vbBinaryCompare) > 0 Then
        NormalizeFieldType = "Bookmark"
    Else
        NormalizeFieldType = "Field"
    End If
End Function

Private Function MakeError(ByVal num As Long, ByVal desc As String, ByVal command As String) As Object
    Dim d As Object
    Set d = CreateObject("Scripting.Dictionary")
    d.Add "__dshError", True
    d.Add "message", DshLibCore.DshLibMsgCommandFail() & ": " & desc
    d.Add "stack", command & " Err " & CStr(num)
    Set MakeError = d
End Function

' ---------------------------------------------------------------- transaction env

Private Sub EnsureTransaction(ByVal docId As String)
    If gInited Then Exit Sub
    Set gFields = CreateObject("Scripting.Dictionary")
    Set gOrder = New Collection
    Set gTempFiles = New Collection
    gNextId = 1
    gTempCounter = 0
    gDocId = docId
    gShowRevisionsSaved = False
    ' Hiding revisions is required to read field codes reliably (DshLibCore C++
    ' calls prepareReadFieldCode() for the same reason).
    On Error Resume Next
    gShowRevisions = ActiveDocument.ShowRevisions
    If Err.Number <> 0 Then gShowRevisions = False
    Err.Clear
    gShowRevisionsSaved = True
    If gShowRevisions Then ActiveDocument.ShowRevisions = False
    Err.Clear
    On Error GoTo 0
    gInited = True
End Sub

Private Sub RestoreEnvironment()
    On Error Resume Next
    If gShowRevisionsSaved Then
        If gShowRevisions Then ActiveDocument.ShowRevisions = True
        gShowRevisionsSaved = False
    End If
    DeleteTempFiles
    DshLibCore.DshLibRestoreScreenUpdating
    On Error GoTo 0
End Sub

Private Sub DeleteTempFiles()
    On Error Resume Next
    Dim i As Long
    For i = 1 To gTempFiles.Count
        Kill gTempFiles(i)
    Next i
    Set gTempFiles = New Collection
    On Error GoTo 0
End Sub

' ---------------------------------------------------------------- info helpers

Private Function NewInfo() As Object
    Dim d As Object
    Set d = CreateObject("Scripting.Dictionary")
    d.Add "id", ""
    d.Add "field", ""
    d.Add "bookmark", ""
    d.Add "noteType", 0
    d.Add "noteIndex", 0
    d.Add "adjacent", False
    d.Add "code", ""
    d.Add "text", ""
    d.Add "order", 0#
    d.Add "rangeStart", 0
    d.Add "rangeEnd", 0
    Set NewInfo = d
End Function

' Store an object into an info Dictionary without relying on Property Set of
' Scripting.Dictionary.Item (Remove + Add is unambiguous).
Private Sub SetInfoObject(ByVal info As Object, ByVal key As String, ByVal obj As Object)
    If info.Exists(key) Then info.Remove key
    If obj Is Nothing Then
        info.Add key, ""
    Else
        info.Add key, obj
    End If
End Sub

Private Function FieldObjectOf(ByVal info As Object) As Object
    Dim fld As Object
    If IsObject(info("field")) Then Set fld = info("field")
    If fld Is Nothing Then
        Set FieldObjectOf = Nothing
        Exit Function
    End If
    On Error Resume Next
    Dim t As String
    t = fld.Code.Text
    If Err.Number <> 0 Then
        Err.Clear
        Set FieldObjectOf = Nothing
        Exit Function
    End If
    On Error GoTo 0
    Set FieldObjectOf = fld
End Function

Private Function FieldRangeOf(ByVal info As Object) As Object
    Dim rng As Object
    On Error Resume Next
    If Len(CStr(info("bookmark"))) > 0 Then
        Set rng = ActiveDocument.Bookmarks(CStr(info("bookmark"))).Range
    Else
        Dim fld As Object
        Set fld = FieldObjectOf(info)
        If Not fld Is Nothing Then
            Set rng = fld.Result.Duplicate
            rng.Start = fld.Code.Start - 1
            rng.End = fld.Result.End + 1
        End If
    End If
    If rng Is Nothing Then Set rng = Selection.Range
    If Err.Number <> 0 Then Err.Clear
    On Error GoTo 0
    Set FieldRangeOf = rng
End Function

Private Function FieldCodeOf(ByVal info As Object) As String
    On Error Resume Next
    If Len(CStr(info("bookmark"))) > 0 Then
        FieldCodeOf = ClientCodeFromBookmarkValue(PropGet(CStr(info("bookmark"))))
    Else
        Dim fld As Object
        Set fld = FieldObjectOf(info)
        If Not fld Is Nothing Then FieldCodeOf = ClientCodeFromFieldCode(SafeFieldCode(fld))
    End If
    If Err.Number <> 0 Or Len(FieldCodeOf) = 0 Then
        Err.Clear
        FieldCodeOf = CStr(info("code"))
    End If
    On Error GoTo 0
End Function

Private Function FieldTextOf(ByVal info As Object) As String
    On Error Resume Next
    If Len(CStr(info("bookmark"))) > 0 Then
        FieldTextOf = ActiveDocument.Bookmarks(CStr(info("bookmark"))).Range.Text
    Else
        Dim fld As Object
        Set fld = FieldObjectOf(info)
        If Not fld Is Nothing Then FieldTextOf = SafeFieldText(fld)
    End If
    If Err.Number <> 0 Then
        Err.Clear
        FieldTextOf = CStr(info("text"))
    End If
    On Error GoTo 0
End Function

Private Function FieldJson(ByVal info As Object) As Object
    Dim d As Object
    Set d = CreateObject("Scripting.Dictionary")
    d.Add "id", CStr(info("id"))
    d.Add "code", CStr(info("code"))
    d.Add "text", CStr(info("text"))
    d.Add "noteIndex", CLng(info("noteIndex"))
    d.Add "adjacent", CBool(info("adjacent"))
    Set FieldJson = d
End Function

Private Function CompositeKey(ByVal info As Object) As String
    CompositeKey = CStr(info("code")) & Chr$(1) & CStr(info("noteType")) & Chr$(1) & CStr(info("noteIndex"))
End Function

' ---------------------------------------------------------------- code parsing

Private Function ClientCodeFromFieldCode(ByVal raw As String) As String
    Dim p As Long
    Dim code As String
    p = InStr(raw, FIELD_PREFIX)
    If p > 0 Then
        code = Mid$(raw, p + Len(FIELD_PREFIX))
    Else
        p = InStr(raw, FIELD_PREFIX_LEGACY)
        If p > 0 Then
            code = Mid$(raw, p + Len(FIELD_PREFIX_LEGACY))
        Else
            ClientCodeFromFieldCode = ""
            Exit Function
        End If
    End If
    If Right$(code, 1) = " " Then code = Left$(code, Len(code) - 1)
    ClientCodeFromFieldCode = code
End Function

Private Function ClientCodeFromBookmarkValue(ByVal v As String) As String
    Dim p As Long
    p = InStr(v, BOOKMARK_CODE_PREFIX)
    If p > 0 Then
        ClientCodeFromBookmarkValue = Mid$(v, p + Len(BOOKMARK_CODE_PREFIX))
        Exit Function
    End If
    p = InStr(v, BOOKMARK_CODE_PREFIX_LEGACY)
    If p > 0 Then
        ClientCodeFromBookmarkValue = Mid$(v, p + Len(BOOKMARK_CODE_PREFIX_LEGACY))
        Exit Function
    End If
    ClientCodeFromBookmarkValue = ""
End Function

Private Function SafeFieldCode(ByVal fld As Object) As String
    On Error Resume Next
    SafeFieldCode = fld.Code.Text
    If Err.Number <> 0 Then SafeFieldCode = ""
    On Error GoTo 0
End Function

Private Function SafeFieldText(ByVal fld As Object) As String
    On Error Resume Next
    SafeFieldText = fld.Result.Text
    If Err.Number <> 0 Then SafeFieldText = ""
    On Error GoTo 0
End Function

' ---------------------------------------------------------------- doc properties

Private Function PropItem(ByVal baseName As String, ByVal index As Long) As Object
    On Error Resume Next
    Set PropItem = ActiveDocument.CustomDocumentProperties.Item(baseName & "_" & CStr(index))
    On Error GoTo 0
End Function

Private Function PropGet(ByVal baseName As String) As String
    Dim s As String
    Dim i As Long
    Dim p As Object
    s = ""
    i = 1
    Do While True
        Set p = PropItem(baseName, i)
        If p Is Nothing Then Exit Do
        s = s & CStr(p.Value)
        i = i + 1
        If i > 1000 Then Exit Do
    Loop
    PropGet = s
End Function

Private Sub PropSet(ByVal baseName As String, ByVal value As String)
    Dim props As Object
    Dim p As Object
    Dim name As String
    Dim chunk As String
    Dim i As Long
    On Error GoTo Done
    Set props = ActiveDocument.CustomDocumentProperties
    i = 1
    Do While True
        name = baseName & "_" & CStr(i)
        If Len(value) >= (i - 1) * MAX_PROPERTY_LENGTH + 1 Then
            chunk = Mid$(value, (i - 1) * MAX_PROPERTY_LENGTH + 1, MAX_PROPERTY_LENGTH)
            Set p = PropItem(baseName, i)
            If p Is Nothing Then
                props.Add name, False, msoPropertyTypeString, chunk
            Else
                p.Value = chunk
            End If
            i = i + 1
        Else
            Do While True
                Set p = PropItem(baseName, i)
                If p Is Nothing Then Exit Do
                p.Delete
                i = i + 1
                If i > 1000 Then Exit Do
            Loop
            Exit Do
        End If
        If i > 1000 Then Exit Do
    Loop
Done:
    On Error GoTo 0
End Sub

Private Sub PropClear(ByVal baseName As String)
    PropSet baseName, ""
End Sub

' ---------------------------------------------------------------- enumeration

Private Sub NoteInfoForRange(ByVal rng As Object, ByRef noteType As Integer, ByRef noteIndex As Long)
    noteType = 0
    noteIndex = 0
    On Error Resume Next
    Dim st As Long
    st = rng.StoryType
    If st = wdFootnotesStory Then
        noteType = 1
        noteIndex = rng.Footnotes(1).Index
    ElseIf st = wdEndnotesStory Then
        noteType = 2
        noteIndex = rng.Endnotes(1).Index
    End If
    If Err.Number <> 0 Then Err.Clear
    On Error GoTo 0
End Sub

Private Sub CollectFieldsFromCollection(ByVal fields As Object, ByVal noteType As Integer, _
                                        ByVal noteIndex As Long, ByRef out As Collection)
    Dim i As Long
    Dim fld As Object
    Dim raw As String
    Dim code As String
    Dim info As Object
    Dim st As Long
    Dim resEnd As Long
    For i = 1 To fields.Count
        Set fld = Nothing
        On Error Resume Next
        Set fld = fields.Item(i)
        On Error GoTo 0
        If Not fld Is Nothing Then
            raw = SafeFieldCode(fld)
            code = ClientCodeFromFieldCode(raw)
            If Len(code) > 0 Then
                Set info = NewInfo()
                SetInfoObject info, "field", fld
                info("noteType") = noteType
                info("noteIndex") = noteIndex
                info("code") = code
                info("text") = SafeFieldText(fld)
                On Error Resume Next
                st = fld.Code.Start
                resEnd = fld.Result.End
                On Error GoTo 0
                If noteType = 0 Then
                    info("order") = CDbl(st)
                Else
                    info("order") = CDbl(noteIndex) * NOTE_OFFSET + CDbl(st)
                End If
                info("rangeStart") = st - 1
                info("rangeEnd") = resEnd + 1
                out.Add info
            End If
        End If
    Next i
End Sub

Private Sub CollectBookmarks(ByRef out As Collection)
    Dim i As Long
    Dim bm As Object
    Dim name As String
    Dim code As String
    Dim info As Object
    Dim nt As Integer
    Dim ni As Long
    Dim st As Long
    Dim en As Long
    Dim rng As Object
    For i = 1 To ActiveDocument.Bookmarks.Count
        Set bm = Nothing
        On Error Resume Next
        Set bm = ActiveDocument.Bookmarks.Item(i)
        On Error GoTo 0
        If Not bm Is Nothing Then
            name = bm.Name
            If Left$(name, Len(BOOKMARK_PREFIX)) = BOOKMARK_PREFIX Then
                code = ClientCodeFromBookmarkValue(PropGet(name))
                If Len(code) > 0 Then
                    Set info = NewInfo()
                    info("bookmark") = name
                    info("code") = code
                    Set rng = Nothing
                    On Error Resume Next
                    Set rng = bm.Range
                    info("text") = rng.Text
                    st = rng.Start
                    en = rng.End
                    On Error GoTo 0
                    NoteInfoForRange rng, nt, ni
                    info("noteType") = nt
                    info("noteIndex") = ni
                    If nt = 0 Then
                        info("order") = CDbl(st)
                    Else
                        info("order") = CDbl(ni) * NOTE_OFFSET + CDbl(st)
                    End If
                    info("rangeStart") = st
                    info("rangeEnd") = en
                    out.Add info
                End If
            End If
        End If
    Next i
End Sub

Private Sub CollectAllCandidates(ByRef out As Collection)
    ' Both representations are enumerated so a document authored as either
    ' Word fields or DshLibCore bookmarks is understood regardless of fieldType.
    CollectFieldsFromCollection ActiveDocument.Content.Fields, 0, 0, out
    Dim fn As Object
    For Each fn In ActiveDocument.Footnotes
        CollectFieldsFromCollection fn.Range.Fields, 1, fn.Index, out
    Next fn
    Dim en As Object
    For Each en In ActiveDocument.Endnotes
        CollectFieldsFromCollection en.Range.Fields, 2, en.Index, out
    Next en
    CollectBookmarks out
End Sub

Private Function RebuildFields(ByVal fieldType As String) As Collection
    Dim candidates As Collection
    Dim arr() As Object
    Dim tmp As Object
    Dim n As Long
    Dim i As Long
    Dim j As Long
    Dim info As Object
    Dim oldMap As Object
    Dim oldId As Variant
    Dim oldInfo As Object
    Dim key As String
    Dim id As String
    Dim newFields As Object
    Dim result As Collection

    Set candidates = New Collection
    CollectAllCandidates candidates
    n = candidates.Count
    If n > 0 Then
        ReDim arr(1 To n)
        For i = 1 To n
            Set arr(i) = candidates(i)
        Next i
        ' Insertion sort by document order (stable enough for a few hundred fields).
        For i = 2 To n
            Set tmp = arr(i)
            j = i - 1
            Do While j >= 1
                If CDbl(arr(j)("order")) <= CDbl(tmp("order")) Then Exit Do
                Set arr(j + 1) = arr(j)
                j = j - 1
            Loop
            Set arr(j + 1) = tmp
        Next i
    End If

    ' Reuse ids from the previous rebuild so ids already handed to the host
    ' (e.g. by cursorInField) remain valid across repeated getFields calls.
    Set oldMap = CreateObject("Scripting.Dictionary")
    Dim bucket As Collection
    For Each oldId In gFields.Keys
        Set oldInfo = gFields(oldId)
        key = CompositeKey(oldInfo)
        If Not oldMap.Exists(key) Then
            Set bucket = New Collection
            oldMap.Add key, bucket
        End If
        oldMap(key).Add CStr(oldId)
    Next oldId

    Set newFields = CreateObject("Scripting.Dictionary")
    Set gOrder = New Collection
    Set result = New Collection
    For i = 1 To n
        Set info = arr(i)
        key = CompositeKey(info)
        id = ""
        If oldMap.Exists(key) Then
            If oldMap(key).Count > 0 Then
                id = CStr(oldMap(key)(1))
                oldMap(key).Remove 1
            End If
        End If
        If Len(id) = 0 Then
            id = "F" & CStr(gNextId)
            gNextId = gNextId + 1
        End If
        info("id") = id
        newFields.Add id, info
        gOrder.Add id
    Next i
    Set gFields = newFields
    ComputeAdjacency
    For i = 1 To gOrder.Count
        result.Add FieldJson(gFields(gOrder(i)))
    Next i
    Set RebuildFields = result
End Function

Private Sub ComputeAdjacency()
    Dim i As Long
    Dim a As Object
    Dim b As Object
    For i = 1 To gOrder.Count
        Set a = gFields(gOrder(i))
        a("adjacent") = False
        If i < gOrder.Count Then
            Set b = gFields(gOrder(i + 1))
            If CInt(a("noteType")) = CInt(b("noteType")) And _
               CLng(a("noteIndex")) = CLng(b("noteIndex")) Then
                If CLng(a("rangeEnd")) = CLng(b("rangeStart")) Then a("adjacent") = True
            End If
        End If
    Next i
End Sub

Private Sub RemoveFromCache(ByVal id As String)
    On Error Resume Next
    gFields.Remove id
    Dim i As Long
    For i = 1 To gOrder.Count
        If gOrder(i) = id Then
            gOrder.Remove i
            Exit For
        End If
    Next i
    On Error GoTo 0
End Sub

' ---------------------------------------------------------------- field creation

Private Function RandomString(ByVal n As Long) As String
    Dim chars As String
    Dim s As String
    Dim i As Long
    chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    Randomize
    For i = 1 To n
        s = s & Mid$(chars, Int(Len(chars) * Rnd) + 1, 1)
    Next i
    RandomString = s
End Function

' Create a new field/bookmark at startRange (Selection.Range when omitted via
' the caller). Returns a fresh info Dictionary, or Nothing on failure.
Private Function CreateFieldAt(ByVal startRange As Object, ByVal fieldType As String, _
                               ByVal noteType As Integer) As Object
    On Error GoTo Fail
    Dim rng As Object
    Set rng = startRange.Duplicate
    Dim info As Object
    Set info = NewInfo()
    Dim wantBookmark As Boolean
    wantBookmark = (fieldType = "Bookmark")

    If (noteType = 1 Or noteType = 2) Then
        If rng.StoryType = wdMainTextStory Then
            If noteType = 1 Then
                Dim fn As Object
                Set fn = ActiveDocument.Footnotes.Add(rng)
                On Error Resume Next
                Dim ref As Object
                Set ref = fn.Reference
                Dim refDup As Object
                Set refDup = ref.Duplicate
                refDup.Collapse wdCollapseEnd
                refDup.Select
                On Error GoTo Fail
                Set rng = fn.Range
            Else
                Dim en As Object
                Set en = ActiveDocument.Endnotes.Add(rng)
                On Error Resume Next
                Dim ref2 As Object
                Set ref2 = en.Reference
                Dim refDup2 As Object
                Set refDup2 = ref2.Duplicate
                refDup2.Collapse wdCollapseEnd
                refDup2.Select
                On Error GoTo Fail
                Set rng = en.Range
            End If
        End If
    End If

    If wantBookmark Then
        rng.Text = FIELD_PLACEHOLDER
        Dim name As String
        name = BOOKMARK_PREFIX & RandomString(12)
        ActiveDocument.Bookmarks.Add name, rng
        info("bookmark") = name
        info("text") = FIELD_PLACEHOLDER
    Else
        ' wdFieldQuote(35) + "{Citation}" placeholder: wdFieldAddin destroys the
        ' Range, and an empty-text field is treated as an empty bibliography.
        Dim fld As Object
        Set fld = ActiveDocument.Fields.Add(rng, wdFieldQuote, FIELD_PLACEHOLDER, True)
        SetInfoObject info, "field", fld
        info("text") = FIELD_PLACEHOLDER
    End If

    Dim nt As Integer
    Dim ni As Long
    Dim st As Long
    Dim resEnd As Long
    NoteInfoForRange rng, nt, ni
    info("noteType") = nt
    info("noteIndex") = ni
    On Error Resume Next
    st = rng.Start
    resEnd = rng.End
    On Error GoTo Fail
    If nt = 0 Then
        info("order") = CDbl(st)
    Else
        info("order") = CDbl(ni) * NOTE_OFFSET + CDbl(st)
    End If
    info("rangeStart") = st
    info("rangeEnd") = resEnd
    If wantBookmark Then
        Set CreateFieldAt = info
    Else
        ' Field ranges include the field markers.
        info("rangeStart") = st - 1
        info("rangeEnd") = resEnd + 1
        Set CreateFieldAt = info
    End If
    Exit Function
Fail:
    Set CreateFieldAt = Nothing
End Function

' ---------------------------------------------------------------- setters

Private Sub SetFieldCode(ByVal info As Object, ByVal code As String)
    On Error GoTo Done
    If Len(CStr(info("bookmark"))) > 0 Then
        PropSet CStr(info("bookmark")), BOOKMARK_CODE_PREFIX & code
    Else
        Dim fld As Object
        Set fld = FieldObjectOf(info)
        If Not fld Is Nothing Then fld.Code.Text = FIELD_PREFIX & code & " "
    End If
    info("code") = code
Done:
    On Error GoTo 0
End Sub

Private Function InsertFileIntoResult(ByVal fld As Object, ByVal path As String, ByVal rtf As String) As Boolean
    On Error GoTo Fail
    Dim res As Object
    Set res = fld.Result
    res.Text = "  "
    Dim ins As Object
    Set ins = res.Duplicate
    ins.MoveEnd wdCharacter, -1
    ins.InsertFile path
    Dim tail As Object
    Set tail = res.Duplicate
    tail.Collapse wdCollapseEnd
    tail.MoveStart wdCharacter, -1
    tail.Text = ""
    RemoveInsertedReturn fld.Result, rtf
    InsertFileIntoResult = True
    Exit Function
Fail:
    InsertFileIntoResult = False
End Function

' Word appends a paragraph mark when it inserts a single-paragraph RTF file.
' Zotero's C++ field.setText removes it for citations; bibliography RTF has
' real entry breaks ("\" + CRLF, \par) and must keep them.
Private Sub RemoveInsertedReturn(ByVal res As Object, ByVal rtf As String)
    On Error GoTo Done
    If InStr(1, rtf, "\" & vbCr, vbBinaryCompare) > 0 Then Exit Sub
    If InStr(1, rtf, "\" & vbLf, vbBinaryCompare) > 0 Then Exit Sub
    If InStr(1, rtf, "\par", vbBinaryCompare) > 0 Then Exit Sub
    Dim tail As Object
    Set tail = res.Duplicate
    tail.Collapse wdCollapseEnd
    tail.MoveStart wdCharacter, -1
    If tail.Text = vbCr Then tail.Text = ""
Done:
    On Error GoTo 0
End Sub

Private Sub SetFieldText(ByVal info As Object, ByVal text As String, ByVal isRich As Boolean)
    Dim plain As String
    Dim body As String
    Dim rich As Boolean
    Dim path As String
    Dim fld As Object
    ' citeproc emits bare RTF fragments for citations. Word's InsertFile only
    ' treats a file as RTF when it begins with "{\rtf"; otherwise the escapes
    ' (\uc0\u252{}, {\i{}...}) land in the document as literal text.
    rich = isRich Or LooksRich(text) Or ContainsRtfFragment(text)
    body = text
    If rich And Left$(Trim$(body), 5) <> "{\rtf" And Left$(Trim$(body), 1) <> "<" Then
        body = "{\rtf " & body & "}"
    End If
    If rich Then plain = RichToPlain(body) Else plain = text
    On Error GoTo PlainFallback

    If Len(CStr(info("bookmark"))) > 0 Then
        Dim name As String
        name = CStr(info("bookmark"))
        Dim rng As Object
        Set rng = ActiveDocument.Bookmarks(name).Range
        If rich Then
            path = WriteTempFile(body, TempExtFor(body))
            If Len(path) = 0 Then GoTo PlainFallback
            rng.Text = "  "
            Dim ins As Object
            Set ins = rng.Duplicate
            ins.MoveEnd wdCharacter, -1
            ins.InsertFile path
            Dim tail As Object
            Set tail = rng.Duplicate
            tail.Collapse wdCollapseEnd
            tail.MoveStart wdCharacter, -1
            tail.Text = ""
            RemoveInsertedReturn rng, body
        Else
            rng.Text = plain
        End If
        ' Replacing a bookmark's range erases the mark, so recreate it.
        On Error Resume Next
        ActiveDocument.Bookmarks.Add name, rng
        If Err.Number <> 0 Then Err.Clear
        On Error GoTo PlainFallback
        info("text") = plain
    Else
        Set fld = FieldObjectOf(info)
        If fld Is Nothing Then GoTo PlainFallback
        If rich Then
            path = WriteTempFile(body, TempExtFor(body))
            If Len(path) = 0 Then GoTo PlainFallback
            If Not InsertFileIntoResult(fld, path, body) Then GoTo PlainFallback
        Else
            fld.Result.Text = plain
        End If
        info("text") = plain
    End If
    On Error GoTo 0
    Exit Sub
PlainFallback:
    On Error Resume Next
    If Len(CStr(info("bookmark"))) > 0 Then
        ActiveDocument.Bookmarks(CStr(info("bookmark"))).Range.Text = plain
    Else
        Set fld = FieldObjectOf(info)
        If Not fld Is Nothing Then fld.Result.Text = plain
    End If
    info("text") = plain
    On Error GoTo 0
End Sub

Private Sub DeleteFieldObject(ByVal info As Object)
    On Error Resume Next
    If Len(CStr(info("bookmark"))) > 0 Then
        PropClear CStr(info("bookmark"))
        ActiveDocument.Bookmarks(CStr(info("bookmark"))).Range.Text = ""
        ActiveDocument.Bookmarks(CStr(info("bookmark"))).Delete
    Else
        Dim fld As Object
        Set fld = FieldObjectOf(info)
        If Not fld Is Nothing Then
            If CInt(info("noteType")) > 0 Then
                Dim r As Object
                Set r = fld.Result
                If r.Footnotes.Count = 1 Then
                    If r.Footnotes(1).Range.Fields.Count <= 1 Then
                        r.Footnotes(1).Delete
                        GoTo Deleted
                    End If
                ElseIf r.Endnotes.Count = 1 Then
                    If r.Endnotes(1).Range.Fields.Count <= 1 Then
                        r.Endnotes(1).Delete
                        GoTo Deleted
                    End If
                End If
            End If
            fld.Delete
Deleted:
        End If
    End If
    On Error GoTo 0
End Sub

' ---------------------------------------------------------------- rich text helpers

Private Function LooksRich(ByVal text As String) As Boolean
    LooksRich = False
    If Left$(LCase$(Trim$(text)), 5) = "{\rtf" Then LooksRich = True
    If Left$(Trim$(text), 1) = "<" Then LooksRich = True
End Function

' A citeproc RTF fragment has no "{\rtf" header but always carries one of
' these control sequences. Detect it so a missing/broken isRich flag can never
' make Word display the markup itself.
Private Function ContainsRtfFragment(ByVal text As String) As Boolean
    ContainsRtfFragment = False
    If InStr(1, text, "\uc0", vbBinaryCompare) > 0 Then ContainsRtfFragment = True
    If InStr(1, text, "\uldash", vbBinaryCompare) > 0 Then ContainsRtfFragment = True
    If InStr(1, text, "\ulclear", vbBinaryCompare) > 0 Then ContainsRtfFragment = True
    If InStr(1, text, "{\i", vbBinaryCompare) > 0 Then ContainsRtfFragment = True
    If InStr(1, text, "\u", vbBinaryCompare) > 0 And InStr(1, text, "{}", vbBinaryCompare) > 0 Then
        ContainsRtfFragment = True
    End If
End Function

Private Function TempExtFor(ByVal text As String) As String
    If Left$(Trim$(text), 1) = "<" Then
        TempExtFor = ".htm"
    Else
        TempExtFor = ".rtf"
    End If
End Function

Private Function RichToPlain(ByVal text As String) As String
    If Left$(Trim$(text), 1) = "<" Then
        RichToPlain = HtmlToPlain(text)
    Else
        RichToPlain = RtfToPlainText(text)
    End If
End Function

Private Function HtmlToPlain(ByVal s As String) As String
    Dim out As String
    Dim i As Long
    Dim c As String
    Dim inTag As Boolean
    For i = 1 To Len(s)
        c = Mid$(s, i, 1)
        If c = "<" Then
            inTag = True
        ElseIf c = ">" Then
            inTag = False
        ElseIf Not inTag Then
            out = out & c
        End If
    Next i
    out = Replace(out, "&nbsp;", " ")
    out = Replace(out, "&amp;", "&")
    out = Replace(out, "&lt;", "<")
    out = Replace(out, "&gt;", ">")
    out = Replace(out, "&quot;", """")
    out = Replace(out, "&#39;", "'")
    HtmlToPlain = out
End Function

Private Function RtfToPlainText(ByVal s As String) As String
    Dim out As String
    Dim i As Long
    Dim j As Long
    Dim c As String
    Dim n As String
    Dim digits As String
    Dim code As Long
    Dim neg As Boolean
    Dim hex As String
    Dim word As String
    i = 1
    Do While i <= Len(s)
        c = Mid$(s, i, 1)
        If c = "\" Then
            If i >= Len(s) Then Exit Do
            n = Mid$(s, i + 1, 1)
            If n = "u" Then
                j = i + 2
                neg = False
                If j <= Len(s) And Mid$(s, j, 1) = "-" Then neg = True: j = j + 1
                digits = ""
                Do While j <= Len(s) And IsDigit(Mid$(s, j, 1))
                    digits = digits & Mid$(s, j, 1)
                    j = j + 1
                Loop
                If Len(digits) > 0 Then
                    code = CLng(Val(digits))
                    If neg Then code = -code
                    If code < 0 Then code = code + 65536
                    out = out & ChrW$(code)
                End If
                If j <= Len(s) And Mid$(s, j, 1) = " " Then j = j + 1
                If j <= Len(s) Then j = j + 1       ' skip one fallback char
                i = j
            ElseIf n = "'" Then
                hex = Mid$(s, i + 2, 2)
                On Error Resume Next
                out = out & ChrW$(CLng(Val("&H" & hex)))
                If Err.Number <> 0 Then Err.Clear
                On Error GoTo 0
                i = i + 4
            ElseIf n = "\" And (Mid$(s, i + 2, 1) = vbCr Or Mid$(s, i + 2, 1) = vbLf) Then
                ' citeproc joins bibliography entries with "\\" + CRLF, which
                ' is an RTF line continuation (a paragraph break), not a
                ' literal backslash.
                out = out & vbCr
                i = i + 2
                Do While i <= Len(s) And (Mid$(s, i, 1) = vbCr Or Mid$(s, i, 1) = vbLf)
                    i = i + 1
                Loop
            ElseIf n = "~" Then
                out = out & Chr$(160)
                i = i + 2
            ElseIf Not IsAlpha(n) Then
                ' Control symbol: \\ \{ \} \- \* etc.
                If n = "\" Or n = "{" Or n = "}" Then out = out & n
                i = i + 2
            Else
                ' Generic control word: letters, optional numeric param, optional space.
                j = i + 1
                word = ""
                Do While j <= Len(s) And IsAlpha(Mid$(s, j, 1))
                    word = word & LCase$(Mid$(s, j, 1))
                    j = j + 1
                Loop
                Do While j <= Len(s) And (IsDigit(Mid$(s, j, 1)) Or Mid$(s, j, 1) = "-")
                    j = j + 1
                Loop
                If j <= Len(s) And Mid$(s, j, 1) = " " Then j = j + 1
                If word = "par" Or word = "line" Then out = out & vbCr
                If word = "tab" Then out = out & vbTab
                i = j
            End If
        ElseIf c = "{" Or c = "}" Then
            i = i + 1
        ElseIf c = vbCr Or c = vbLf Then
            i = i + 1
        Else
            out = out & c
            i = i + 1
        End If
    Loop
    RtfToPlainText = out
End Function

Private Function IsDigit(ByVal c As String) As Boolean
    If Len(c) = 0 Then
        IsDigit = False
    Else
        IsDigit = (c >= "0" And c <= "9")
    End If
End Function

Private Function IsAlpha(ByVal c As String) As Boolean
    If Len(c) = 0 Then
        IsAlpha = False
    Else
        Dim u As String
        u = UCase$(c)
        IsAlpha = (u >= "A" And u <= "Z")
    End If
End Function

Private Function WriteTempFile(ByVal content As String, ByVal ext As String) As String
    Dim folder As String
    Dim path As String
    Dim f As Integer
    folder = Environ$("TEMP")
    If Len(folder) = 0 Then folder = Environ$("TMP")
    If Len(folder) = 0 Then folder = CurDir$()
    If Right$(folder, 1) <> "\" Then folder = folder & "\"
    gTempCounter = gTempCounter + 1
    path = folder & "dsh_word_" & CStr(CLng(Timer * 1000)) & "_" & CStr(gTempCounter) & ext
    On Error GoTo Fail
    f = FreeFile
    Open path For Binary Access Write As #f
    If Len(content) > 0 Then
        Dim b() As Byte
        b = DshLibCore.DshLibUtf8Encode(content)
        Put #f, , b
    End If
    Close #f
    gTempFiles.Add path
    WriteTempFile = path
    Exit Function
Fail:
    On Error Resume Next
    Close #f
    WriteTempFile = ""
End Function

Private Sub InsertRichAtRange(ByVal rng As Object, ByVal text As String)
    Dim rich As Boolean
    Dim body As String
    rich = LooksRich(text) Or ContainsRtfFragment(text)
    body = text
    If rich And Left$(Trim$(body), 5) <> "{\rtf" And Left$(Trim$(body), 1) <> "<" Then
        body = "{\rtf " & body & "}"
    End If
    If Not rich Then
        On Error Resume Next
        rng.InsertAfter text
        On Error GoTo 0
        Exit Sub
    End If
    Dim path As String
    path = WriteTempFile(body, TempExtFor(body))
    If Len(path) = 0 Then
        On Error Resume Next
        rng.Text = RichToPlain(body)
        On Error GoTo 0
        Exit Sub
    End If
    On Error GoTo Fail
    rng.Text = "  "
    Dim ins As Object
    Set ins = rng.Duplicate
    ins.MoveEnd wdCharacter, -1
    ins.InsertFile path
    Dim tail As Object
    Set tail = rng.Duplicate
    tail.Collapse wdCollapseEnd
    tail.MoveStart wdCharacter, -1
    tail.Text = ""
    Exit Sub
Fail:
    On Error Resume Next
    rng.Text = RichToPlain(body)
    On Error GoTo 0
End Sub

' ---------------------------------------------------------------- Document commands

Private Sub CmdGetActiveDocument(args As Variant, ByRef result As Variant)
    Dim d As Object
    Dim notes As Collection
    Dim docId As String
    docId = ActiveDocument.FullName
    If Len(docId) = 0 Then docId = ActiveDocument.Name
    Set d = CreateObject("Scripting.Dictionary")
    d.Add "documentID", docId
    d.Add "outputFormat", "rtf"
    Set notes = New Collection
    notes.Add "footnotes"
    notes.Add "endnotes"
    d.Add "supportedNotes", notes
    d.Add "supportsImportExport", True
    d.Add "supportsTextInsertion", True
    d.Add "supportsCitationMerging", True
    d.Add "processorName", "Word"
    Set result = d
End Sub

Private Sub CmdActivate(args As Variant, ByRef result As Variant)
    On Error Resume Next
    ActiveDocument.Activate
    On Error GoTo 0
    result = Null
End Sub

Private Sub CmdCanInsertField(args As Variant, ByRef result As Variant)
    Dim st As Long
    Dim can As Boolean
    On Error Resume Next
    st = Selection.StoryType
    can = (st = wdMainTextStory Or st = wdFootnotesStory Or st = wdEndnotesStory)
    If can Then
        If Selection.Hyperlinks.Count > 0 Then can = False
    End If
    If Err.Number <> 0 Then can = True
    Err.Clear
    On Error GoTo 0
    result = can
End Sub

Private Sub CmdDisplayAlert(args As Variant, ByRef result As Variant)
    Dim text As String
    Dim icon As Long
    Dim buttons As Long
    Dim mbIcon As Long
    Dim mbButtons As Long
    Dim clicked As Long
    Dim ret As Long
    text = ArgStr(args, 2, "")
    icon = CLng(ArgNum(args, 3, 0))
    buttons = CLng(ArgNum(args, 4, 0))
    Select Case icon
        Case 0: mbIcon = vbCritical
        Case 1: mbIcon = vbExclamation
        Case 2: mbIcon = vbInformation
        Case Else: mbIcon = vbInformation
    End Select
    Select Case buttons
        Case 1: mbButtons = vbOKCancel
        Case 2: mbButtons = vbYesNo
        Case 3: mbButtons = vbYesNoCancel
        Case Else: mbButtons = vbOKOnly
    End Select
    clicked = MsgBox(text, mbButtons + mbIcon + vbSystemModal, DshLibCore.DshLibCN("6587 5E93 5F15 7528"))
    ' Return values follow the DshLibCore C++ displayAlert mapping (truthy = OK/Yes).
    Select Case buttons
        Case 0: ret = 0
        Case 1: If clicked = vbOK Then ret = 1 Else ret = 0
        Case 2: If clicked = vbYes Then ret = 1 Else ret = 0
        Case 3:
            If clicked = vbYes Then
                ret = 2
            ElseIf clicked = vbNo Then
                ret = 1
            Else
                ret = 0
            End If
        Case Else: ret = 0
    End Select
    result = ret
End Sub

Private Sub CmdGetDocumentData(args As Variant, ByRef result As Variant)
    Dim firstPara As String
    Dim r As Object
    On Error Resume Next
    Set r = ActiveDocument.Content
    r.Collapse wdCollapseStart
    r.MoveEnd wdParagraph, 1
    firstPara = r.Text
    On Error GoTo 0
    If Left$(firstPara, Len(EXPORT_MARKER)) = EXPORT_MARKER Or _
       Left$(firstPara, Len(EXPORT_MARKER_LEGACY)) = EXPORT_MARKER_LEGACY Then
        result = EXPORT_MARKER
        Exit Sub
    End If
    Dim data As String
    data = PropGet(PREFS_PROPERTY)
    If Len(data) = 0 Then data = DEFAULT_DOC_DATA
    result = data
End Sub

Private Sub CmdSetDocumentData(args As Variant, ByRef result As Variant)
    PropSet PREFS_PROPERTY, Trim$(ArgStr(args, 2, ""))
    result = Null
End Sub

Private Sub CmdSetBibliographyStyle(args As Variant, ByRef result As Variant)
    On Error GoTo Done
    Dim firstLine As Double
    Dim body As Double
    Dim lineSp As Double
    Dim entry As Double
    Dim stops As Variant
    Dim id As Variant
    Dim info As Object
    Dim rng As Object
    Dim pf As Object
    Dim col As Collection
    Dim k As Long
    firstLine = ArgNum(args, 2, 0) / 20
    body = ArgNum(args, 3, 0) / 20
    lineSp = ArgNum(args, 4, 0) / 20
    entry = ArgNum(args, 5, 0) / 20
    stops = JsonArg(args, 6, Null)
    For Each id In gOrder
        Set info = gFields(id)
        If Left$(FieldCodeOf(info), 4) = "BIBL" Then
            Set rng = FieldRangeOf(info)
            Set pf = rng.ParagraphFormat
            pf.FirstLineIndent = firstLine
            pf.LeftIndent = body
            pf.LineSpacingRule = wdLineSpaceExactly
            pf.LineSpacing = lineSp
            pf.SpaceAfter = entry
            pf.TabStops.ClearAll
            Set col = JsonArr(stops)
            For k = 1 To col.Count
                pf.TabStops.Add CDbl(Val(CStr(col(k)))) / 20, 0, 0
            Next k
            Exit For
        End If
    Next id
Done:
    On Error GoTo 0
    result = Null
End Sub

Private Sub CmdInsertText(args As Variant, ByRef result As Variant)
    On Error Resume Next
    InsertRichAtRange Selection.Range, ArgStr(args, 2, "")
    On Error GoTo 0
    result = Null
End Sub

Private Sub CmdGetFields(args As Variant, ByRef result As Variant)
    Dim col As Collection
    Set col = RebuildFields(NormalizeFieldType(ArgStr(args, 2, "Field")))
    Set result = col
End Sub

Private Sub CmdCursorInField(args As Variant, ByRef result As Variant)
    Dim fieldType As String
    Dim tmp As Collection
    Dim selStart As Long
    Dim selEnd As Long
    Dim selStory As Long
    Dim id As Variant
    Dim info As Object
    fieldType = NormalizeFieldType(ArgStr(args, 2, "Field"))
    If gFields.Count = 0 Then Set tmp = RebuildFields(fieldType)
    result = Null
    On Error Resume Next
    selStart = Selection.Range.Start
    selEnd = Selection.Range.End
    selStory = Selection.StoryType
    On Error GoTo 0
    For Each id In gOrder
        Set info = gFields(id)
        Dim fieldStory As Long
        fieldStory = CInt(info("noteType")) + 1
        If fieldStory = selStory Then
            If CLng(info("rangeStart")) <= selEnd And CLng(info("rangeEnd")) >= selStart Then
                Set result = FieldJson(info)
                Exit For
            End If
        End If
    Next id
End Sub

' Give a freshly created field an id, register it in the transaction maps and
' fill the ByRef result with its JSON shape (shared by insertField and the AI
' insertion commands).
Private Sub RegisterNewField(ByVal info As Object, ByRef result As Variant)
    Dim id As String
    id = "F" & CStr(gNextId)
    gNextId = gNextId + 1
    info("id") = id
    gFields.Add id, info
    gOrder.Add id
    Set result = FieldJson(info)
End Sub

Private Sub CmdInsertField(args As Variant, ByRef result As Variant)
    Dim fieldType As String
    Dim noteType As Integer
    Dim info As Object
    fieldType = NormalizeFieldType(ArgStr(args, 2, "Field"))
    noteType = CInt(ArgNum(args, 3, 0))
    Set info = CreateFieldAt(Selection.Range, fieldType, noteType)
    If info Is Nothing Then
        result = Null
        Exit Sub
    End If
    RegisterNewField info, result
End Sub

Private Sub CmdConvert(args As Variant, ByRef result As Variant)
    Dim ids As Variant
    Dim noteTypes As Variant
    Dim toFieldType As String
    Dim idCol As Collection
    Dim ntCol As Collection
    Dim i As Long
    Dim id As String
    Dim nt As Integer
    ids = JsonArg(args, 2, Null)
    toFieldType = NormalizeFieldType(ArgStr(args, 3, "Field"))
    noteTypes = JsonArg(args, 4, Null)
    Set idCol = JsonArr(ids)
    Set ntCol = JsonArr(noteTypes)
    For i = 1 To idCol.Count
        id = CStr(idCol(i))
        If gFields.Exists(id) Then
            If i <= ntCol.Count Then
                nt = CInt(Val(CStr(ntCol(i))))
            Else
                nt = CInt(gFields(id)("noteType"))
            End If
            ConvertOneField id, toFieldType, nt
        End If
    Next i
    result = Null
End Sub

Private Sub ConvertOneField(ByVal id As String, ByVal toFieldType As String, ByVal toNoteType As Integer)
    On Error GoTo SafeExit
    Dim info As Object
    Dim code As String
    Dim txt As String
    Dim curIsBookmark As Boolean
    Dim wantBookmark As Boolean
    Dim curNote As Integer
    Dim rng As Object
    Dim newInfo As Object
    Dim name As String
    Set info = gFields(id)
    code = FieldCodeOf(info)
    txt = FieldTextOf(info)
    curIsBookmark = (Len(CStr(info("bookmark"))) > 0)
    wantBookmark = (toFieldType = "Bookmark")
    curNote = CInt(info("noteType"))
    If (curIsBookmark = wantBookmark) And (curNote = toNoteType) Then Exit Sub

    Set rng = FieldRangeOf(info)
    rng.Text = FIELD_PLACEHOLDER
    If curIsBookmark Then
        name = CStr(info("bookmark"))
        PropClear name
        On Error Resume Next
        ActiveDocument.Bookmarks(name).Delete
        Err.Clear
        On Error GoTo SafeExit
    End If
    Set newInfo = CreateFieldAt(rng, toFieldType, toNoteType)
    If newInfo Is Nothing Then Exit Sub
    SetFieldCode newInfo, code
    SetFieldText newInfo, txt, False
    newInfo("id") = id
    gFields.Remove id
    gFields.Add id, newInfo
SafeExit:
    On Error GoTo 0
End Sub

Private Sub CmdConvertPlaceholdersToFields(args As Variant, ByRef result As Variant)
    Dim codes As Variant
    Dim placeholderIDs As Variant
    Dim noteType As Integer
    Dim fieldType As String
    Dim idCol As Collection
    Dim out As Collection
    Dim i As Long
    Dim link As Object
    Dim addr As String
    Dim pid As String
    Dim rng As Object
    Dim info As Object
    Dim id As String
    codes = JsonArg(args, 2, Null)
    placeholderIDs = JsonArg(args, 3, Null)
    noteType = CInt(ArgNum(args, 4, 0))
    fieldType = "Field"
    Set idCol = JsonArr(placeholderIDs)
    Set out = New Collection
    For i = ActiveDocument.Hyperlinks.Count To 1 Step -1
        Set link = Nothing
        addr = ""
        On Error Resume Next
        Set link = ActiveDocument.Hyperlinks.Item(i)
        If Not link Is Nothing Then addr = CStr(link.Address)
        If Err.Number <> 0 Then Err.Clear
        On Error GoTo 0
        If link Is Nothing Then GoTo NextLink
        If InStr(addr, PLACEHOLDER_URL & "?") = 1 Then
            pid = Mid$(addr, Len(PLACEHOLDER_URL) + 2)
            If Len(pid) > 6 Then pid = Right$(pid, 6)
            If PlaceholderMatches(pid, idCol) Then
                Set rng = link.Range
                rng.Text = ""
                Set info = CreateFieldAt(rng, fieldType, noteType)
                If Not info Is Nothing Then
                    SetFieldCode info, "TEMP"
                    info("code") = "TEMP"
                    id = "F" & CStr(gNextId)
                    gNextId = gNextId + 1
                    info("id") = id
                    gFields.Add id, info
                    gOrder.Add id
                    out.Add FieldJson(info)
                End If
            End If
        End If
NextLink:
    Next i
    Set result = out
End Sub

Private Function PlaceholderMatches(ByVal pid As String, ByVal idCol As Collection) As Boolean
    Dim k As Long
    Dim s As String
    PlaceholderMatches = False
    For k = 1 To idCol.Count
        s = CStr(idCol(k))
        If Len(s) > 0 Then
            If InStr(pid, s) = 1 Or InStr(s, pid) = 1 Then
                PlaceholderMatches = True
                Exit Function
            End If
        End If
    Next k
End Function

Private Sub CmdImportDocument(args As Variant, ByRef result As Variant)
    Dim docData As String
    Dim i As Long
    Dim link As Object
    Dim t As String
    Dim rng As Object
    Dim info As Object
    Dim id As String
    docData = ""
    For i = ActiveDocument.Hyperlinks.Count To 1 Step -1
        Set link = Nothing
        t = ""
        On Error Resume Next
        Set link = ActiveDocument.Hyperlinks.Item(i)
        If Not link Is Nothing Then t = Trim$(link.Range.Text)
        If Err.Number <> 0 Then Err.Clear
        On Error GoTo 0
        If link Is Nothing Then GoTo NextImp
        If Left$(t, Len(IMPORT_ITEM_PREFIX)) = IMPORT_ITEM_PREFIX Or _
           Left$(t, Len(IMPORT_BIBL_PREFIX)) = IMPORT_BIBL_PREFIX Then
            Set rng = link.Range
            Set info = CreateFieldAt(rng, "Field", 0)
            If Not info Is Nothing Then
                SetFieldCode info, t
                info("code") = t
                id = "F" & CStr(gNextId)
                gNextId = gNextId + 1
                info("id") = id
                gFields.Add id, info
                gOrder.Add id
            End If
        ElseIf Left$(t, Len(IMPORT_DOC_PREFS_PREFIX)) = IMPORT_DOC_PREFS_PREFIX Then
            docData = Mid$(t, Len(IMPORT_DOC_PREFS_PREFIX) + 1)
            PropSet PREFS_PROPERTY, docData
            link.Range.Text = ""
        ElseIf Left$(t, Len(IMPORT_BIBSTYLE_PREFIX)) = IMPORT_BIBSTYLE_PREFIX Then
            If Len(docData) = 0 Then docData = t
            link.Range.Text = ""
        End If
NextImp:
    Next i
    RemoveImportMarker
    If Len(docData) = 0 Then docData = PropGet(PREFS_PROPERTY)
    result = docData
End Sub

Private Sub RemoveImportMarker()
    Dim r As Object
    On Error Resume Next
    Set r = ActiveDocument.Content
    r.Collapse wdCollapseStart
    r.MoveEnd wdParagraph, 1
    Dim first As String
    first = r.Text
    If Left$(first, Len(EXPORT_MARKER)) = EXPORT_MARKER Or _
       Left$(first, Len(EXPORT_MARKER_LEGACY)) = EXPORT_MARKER_LEGACY Then
        Dim r2 As Object
        Set r2 = ActiveDocument.Content
        r2.Collapse wdCollapseStart
        r2.MoveEnd wdParagraph, 4
        r2.Text = ""
    End If
    On Error GoTo 0
End Sub

Private Sub CmdExportDocument(args As Variant, ByRef result As Variant)
    Dim fieldType As String
    Dim instructions As String
    Dim tmp As Collection
    Dim i As Long
    Dim info As Object
    Dim code As String
    Dim rng As Object
    Dim dd As String
    Dim endRange As Object
    Dim head As Object
    fieldType = NormalizeFieldType(ArgStr(args, 2, "Field"))
    instructions = ArgStr(args, 3, "")
    Set tmp = RebuildFields(fieldType)
    For i = gOrder.Count To 1 Step -1
        Set info = gFields(gOrder(i))
        code = FieldCodeOf(info)
        Set rng = FieldRangeOf(info)
        rng.Text = code
        On Error Resume Next
        ActiveDocument.Hyperlinks.Add rng, PLACEHOLDER_URL
        Err.Clear
        On Error GoTo 0
    Next i
    dd = PropGet(PREFS_PROPERTY)
    Set endRange = ActiveDocument.Content
    endRange.InsertParagraphAfter
    endRange.Collapse wdCollapseEnd
    endRange.InsertAfter IMPORT_DOC_PREFS_PREFIX & dd
    On Error Resume Next
    ActiveDocument.Hyperlinks.Add endRange, PLACEHOLDER_URL
    Err.Clear
    On Error GoTo 0
    Set head = ActiveDocument.Content
    head.InsertParagraphBefore
    head.InsertParagraphBefore
    head.InsertBefore instructions & vbCr
    head.InsertParagraphBefore
    head.InsertParagraphBefore
    head.InsertBefore EXPORT_MARKER & vbCr
    result = Null
End Sub

Private Sub CmdCleanup(args As Variant, ByRef result As Variant)
    RestoreEnvironment
    result = Null
End Sub

Private Sub CmdComplete(args As Variant, ByRef result As Variant)
    DshLibCore.DshLibEndUndoRecord
    result = Null
End Sub

' ---------------------------------------------------------------- Field commands

Private Sub CmdFieldDelete(args As Variant, ByRef result As Variant)
    Dim id As String
    id = ArgStr(args, 2, "")
    If gFields.Exists(id) Then
        DeleteFieldObject gFields(id)
        RemoveFromCache id
    End If
    result = Null
End Sub

Private Sub CmdFieldSelect(args As Variant, ByRef result As Variant)
    Dim id As String
    id = ArgStr(args, 2, "")
    If gFields.Exists(id) Then
        On Error Resume Next
        FieldRangeOf(gFields(id)).Select
        On Error GoTo 0
    End If
    result = Null
End Sub

Private Sub CmdFieldRemoveCode(args As Variant, ByRef result As Variant)
    Dim id As String
    Dim info As Object
    id = ArgStr(args, 2, "")
    If gFields.Exists(id) Then
        Set info = gFields(id)
        On Error Resume Next
        If Len(CStr(info("bookmark"))) > 0 Then
            ActiveDocument.Bookmarks(CStr(info("bookmark"))).Delete
            PropClear CStr(info("bookmark"))
        Else
            Dim fld As Object
            Set fld = FieldObjectOf(info)
            If Not fld Is Nothing Then fld.Unlink
        End If
        On Error GoTo 0
        RemoveFromCache id
    End If
    result = Null
End Sub

Private Sub CmdFieldSetText(args As Variant, ByRef result As Variant)
    Dim id As String
    id = ArgStr(args, 2, "")
    If gFields.Exists(id) Then
        SetFieldText gFields(id), ArgStr(args, 3, ""), ArgBool(args, 4, False)
    End If
    result = Null
End Sub

Private Sub CmdFieldSetCode(args As Variant, ByRef result As Variant)
    Dim id As String
    id = ArgStr(args, 2, "")
    If gFields.Exists(id) Then SetFieldCode gFields(id), ArgStr(args, 3, "")
    result = Null
End Sub

Private Sub CmdFieldGetText(args As Variant, ByRef result As Variant)
    Dim id As String
    id = ArgStr(args, 2, "")
    If gFields.Exists(id) Then result = FieldTextOf(gFields(id)) Else result = ""
End Sub

Private Sub CmdFieldGetCode(args As Variant, ByRef result As Variant)
    Dim id As String
    id = ArgStr(args, 2, "")
    If gFields.Exists(id) Then result = FieldCodeOf(gFields(id)) Else result = ""
End Sub

Private Sub CmdFieldGetNoteIndex(args As Variant, ByRef result As Variant)
    Dim id As String
    id = ArgStr(args, 2, "")
    If gFields.Exists(id) Then result = CLng(gFields(id)("noteIndex")) Else result = 0
End Sub

Private Sub CmdFieldEquals(args As Variant, ByRef result As Variant)
    Dim id As String
    Dim other As Variant
    Dim otherId As String
    id = ArgStr(args, 2, "")
    other = JsonArg(args, 3, Null)
    otherId = ""
    If IsObject(other) Then
        If JsonHas(other, "id") Then otherId = CStr(JsonGet(other, "id"))
    ElseIf Not IsNull(other) And Not IsEmpty(other) Then
        otherId = CStr(other)
    End If
    result = (Len(id) > 0 And id = otherId)
End Sub

Private Sub CmdFieldIsAdjacent(args As Variant, ByRef result As Variant)
    Dim id As String
    id = ArgStr(args, 2, "")
    If gFields.Exists(id) Then result = CBool(gFields(id)("adjacent")) Else result = False
End Sub
