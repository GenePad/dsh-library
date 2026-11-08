Attribute VB_Name = "DshLibJson"
' Minimal, dependency-free JSON parser/serializer for the Word VBA client.
' Objects are Scripting.Dictionary (late bound), arrays are Collection,
' JSON null maps to VBA Null, JSON booleans to VBA Boolean.
' All identifiers/comments are ASCII so the VBE never mangles them on import.
Option Explicit
Option Compare Binary

Private mText As String
Private mPos As Long
Private mLen As Long
Private mErr As String

' ---------------------------------------------------------------- public API

Public Function JsonParse(ByVal text As String) As Variant
    Dim tmp As Variant
    JsonParseInto text, tmp
    If IsObject(tmp) Then
        Set JsonParse = tmp
    Else
        JsonParse = tmp
    End If
End Function

' Parse into a ByRef Variant. Use this when the caller needs to be certain an
' object result is preserved (Set) rather than Let-coerced.
Public Sub JsonParseInto(ByVal text As String, ByRef target As Variant)
    mText = text
    mLen = Len(text)
    mPos = 1
    mErr = ""
    If mLen = 0 Then
        target = Null
        Exit Sub
    End If
    SkipWs
    Dim tmp As Variant
    ParseValueInto tmp
    If IsObject(tmp) Then
        Set target = tmp
    Else
        target = tmp
    End If
End Sub

Public Function JsonStringify(ByVal value As Variant) As String
    JsonStringify = StringifyValue(value)
End Function

' Read a key from a JSON object (Dictionary). Missing key -> Null.
Public Function JsonGet(obj As Variant, key As String) As Variant
    JsonGet = Null
    If IsNull(obj) Or IsEmpty(obj) Then Exit Function
    If Not IsObject(obj) Then Exit Function
    If TypeName(obj) <> "Dictionary" Then Exit Function
    If Not obj.Exists(key) Then Exit Function
    If IsObject(obj.Item(key)) Then
        Set JsonGet = obj.Item(key)
    Else
        JsonGet = obj.Item(key)
    End If
End Function

' Read a key into a ByRef Variant, preserving object results with Set.
Public Sub JsonGetInto(obj As Variant, key As String, ByRef target As Variant)
    target = Null
    If IsNull(obj) Or IsEmpty(obj) Then Exit Sub
    If Not IsObject(obj) Then Exit Sub
    If TypeName(obj) <> "Dictionary" Then Exit Sub
    If Not obj.Exists(key) Then Exit Sub
    If IsObject(obj.Item(key)) Then
        Set target = obj.Item(key)
    Else
        target = obj.Item(key)
    End If
End Sub

Public Function JsonHas(obj As Variant, key As String) As Boolean
    JsonHas = False
    If IsNull(obj) Or IsEmpty(obj) Then Exit Function
    If Not IsObject(obj) Then Exit Function
    If TypeName(obj) <> "Dictionary" Then Exit Function
    JsonHas = obj.Exists(key)
End Function

' Coerce a Variant into a Collection of arguments (1-based).
' Null/Empty -> empty collection; a Collection passes through; a VBA array
' is copied; any scalar becomes a single-element collection.
Public Function JsonArr(args As Variant) As Collection
    Dim col As New Collection
    If IsNull(args) Or IsEmpty(args) Then
        Set JsonArr = col
        Exit Function
    End If
    If TypeName(args) = "Collection" Then
        Set JsonArr = args
        Exit Function
    End If
    If IsArray(args) Then
        Dim i As Long
        On Error Resume Next
        For i = LBound(args) To UBound(args)
            col.Add args(i)
        Next i
        On Error GoTo 0
        Set JsonArr = col
        Exit Function
    End If
    col.Add args
    Set JsonArr = col
End Function

' Safe 1-based indexed access to an arguments collection.
Public Function JsonArg(args As Variant, ByVal index As Long, ByVal def As Variant) As Variant
    Dim col As Collection
    Set col = JsonArr(args)
    If index >= 1 And index <= col.Count Then
        If IsObject(col.Item(index)) Then
            Set JsonArg = col.Item(index)
        Else
            JsonArg = col.Item(index)
        End If
    ElseIf IsObject(def) Then
        Set JsonArg = def
    Else
        JsonArg = def
    End If
End Function

' Convenience constructors.
Public Function JsonObj() As Object
    Set JsonObj = CreateObject("Scripting.Dictionary")
End Function

Public Function JsonNewArray() As Collection
    Set JsonNewArray = New Collection
End Function

' Last parse error (empty string when the input was valid).
Public Function JsonLastError() As String
    JsonLastError = mErr
End Function

' ---------------------------------------------------------------- parser

' Store a parsed value without relying on Property Set of Dictionary/Collection
' Item (Remove+Add / typed object variable is unambiguous).
Private Sub DictPut(ByVal d As Object, ByVal key As String, ByVal val As Variant)
    If d.Exists(key) Then d.Remove key
    If IsObject(val) Then
        Dim obj As Object
        Set obj = val
        d.Add key, obj
    Else
        d.Add key, val
    End If
End Sub

Private Sub ColPut(ByVal col As Collection, ByVal val As Variant)
    If IsObject(val) Then
        Dim obj As Object
        Set obj = val
        col.Add obj
    Else
        col.Add val
    End If
End Sub

Private Function Peek() As String
    If mPos > mLen Then
        Peek = ""
    Else
        Peek = Mid$(mText, mPos, 1)
    End If
End Function

Private Sub SkipWs()
    Do While mPos <= mLen
        Dim c As String
        c = Mid$(mText, mPos, 1)
        If c = " " Or c = vbTab Or c = vbCr Or c = vbLf Then
            mPos = mPos + 1
        Else
            Exit Do
        End If
    Loop
End Sub

Private Function MatchWord(ByVal w As String) As Boolean
    If Mid$(mText, mPos, Len(w)) = w Then
        mPos = mPos + Len(w)
        MatchWord = True
    Else
        mErr = "Invalid literal at " & CStr(mPos)
        MatchWord = False
    End If
End Function

' Parse the next value into a ByRef Variant. Set-assign for object results,
' Let for scalars; callers always see a single, correctly typed Variant.
Private Sub ParseValueInto(ByRef target As Variant)
    SkipWs
    Dim c As String
    c = Peek()
    Select Case c
        Case "{"
            Set target = ParseObject()
        Case "["
            Set target = ParseArray()
        Case """"
            target = ParseString()
        Case "t"
            If MatchWord("true") Then target = True Else target = Empty
        Case "f"
            If MatchWord("false") Then target = False Else target = Empty
        Case "n"
            If MatchWord("null") Then target = Null Else target = Empty
        Case Else
            target = ParseNumber()
    End Select
End Sub

Private Function ParseObject() As Object
    Dim d As Object
    Set d = CreateObject("Scripting.Dictionary")
    mPos = mPos + 1                     ' consume {
    SkipWs
    If Peek() = "}" Then
        mPos = mPos + 1
        Set ParseObject = d
        Exit Function
    End If
    Do While mPos <= mLen
        SkipWs
        If Peek() <> """" Then
            mErr = "Expected object key at " & CStr(mPos)
            Exit Do
        End If
        Dim key As String
        key = ParseString()
        SkipWs
        If Peek() = ":" Then mPos = mPos + 1
        SkipWs
        Dim val As Variant
        ParseValueInto val
        DictPut d, key, val
        SkipWs
        Dim c As String
        c = Peek()
        If c = "," Then
            mPos = mPos + 1
        ElseIf c = "}" Then
            mPos = mPos + 1
            Exit Do
        Else
            mErr = "Expected , or } at " & CStr(mPos)
            Exit Do
        End If
    Loop
    Set ParseObject = d
End Function

Private Function ParseArray() As Collection
    Dim col As New Collection
    mPos = mPos + 1                     ' consume [
    SkipWs
    If Peek() = "]" Then
        mPos = mPos + 1
        Set ParseArray = col
        Exit Function
    End If
    Do While mPos <= mLen
        SkipWs
        Dim val As Variant
        ParseValueInto val
        ColPut col, val
        SkipWs
        Dim c As String
        c = Peek()
        If c = "," Then
            mPos = mPos + 1
        ElseIf c = "]" Then
            mPos = mPos + 1
            Exit Do
        Else
            mErr = "Expected , or ] at " & CStr(mPos)
            Exit Do
        End If
    Loop
    Set ParseArray = col
End Function

Private Function ParseString() As String
    Dim out As String
    mPos = mPos + 1                     ' consume opening quote
    Do While mPos <= mLen
        Dim c As String
        c = Mid$(mText, mPos, 1)
        If c = """" Then
            mPos = mPos + 1
            ParseString = out
            Exit Function
        ElseIf c = "\" Then
            mPos = mPos + 1
            If mPos > mLen Then Exit Do
            Dim e As String
            e = Mid$(mText, mPos, 1)
            Select Case e
                Case """": out = out & """"
                Case "\": out = out & "\"
                Case "/": out = out & "/"
                Case "b": out = out & Chr$(8)
                Case "f": out = out & Chr$(12)
                Case "n": out = out & vbLf
                Case "r": out = out & vbCr
                Case "t": out = out & vbTab
                Case "u"
                    ' Four hex digits follow the 'u'. ChrW$ handles the BMP;
                    ' a surrogate pair is simply two consecutive ChrW$ values,
                    ' which is exactly how VBA stores supplementary characters.
                    Dim h As String
                    h = Mid$(mText, mPos + 1, 4)
                    out = out & ChrW$(HexVal4(h))
                    mPos = mPos + 4
                Case Else
                    out = out & e
            End Select
            mPos = mPos + 1
        Else
            out = out & c
            mPos = mPos + 1
        End If
    Loop
    ParseString = out
End Function

Private Function ParseNumber() As Variant
    Dim startPos As Long
    startPos = mPos
    Do While mPos <= mLen
        Dim c As String
        c = Mid$(mText, mPos, 1)
        If (c >= "0" And c <= "9") Or c = "-" Or c = "+" Or c = "." Or c = "e" Or c = "E" Then
            mPos = mPos + 1
        Else
            Exit Do
        End If
    Loop
    Dim s As String
    s = Mid$(mText, startPos, mPos - startPos)
    If Len(s) = 0 Then
        mErr = "Expected value at " & CStr(mPos)
        ParseNumber = Empty
        Exit Function
    End If
    ' Val() is locale independent for '.', but does not understand exponents,
    ' so split the exponent off and apply it afterwards.
    Dim ePos As Long
    Dim expPart As Long
    expPart = 0
    ePos = InStr(1, s, "e", vbTextCompare)
    If ePos > 0 Then
        expPart = CLng(Val(Mid$(s, ePos + 1)))
        s = Left$(s, ePos - 1)
    End If
    Dim v As Double
    v = Val(s)
    If expPart <> 0 Then v = v * (10 ^ expPart)
    If v = Int(v) And v >= -2147483648# And v <= 2147483647# Then
        ParseNumber = CLng(v)
    Else
        ParseNumber = CDbl(v)
    End If
End Function

Private Function HexVal4(ByVal h As String) As Long
    Dim v As Long
    Dim i As Long
    Dim c As String
    Dim d As Long
    v = 0
    For i = 1 To 4
        c = UCase$(Mid$(h, i, 1))
        d = InStr("0123456789ABCDEF", c) - 1
        If d < 0 Then d = 0
        v = v * 16 + d
    Next i
    HexVal4 = v
End Function

' ---------------------------------------------------------------- serializer

Private Function StringifyValue(ByVal v As Variant) As String
    If IsNull(v) Or IsEmpty(v) Then
        StringifyValue = "null"
    ElseIf IsObject(v) Then
        If v Is Nothing Then
            StringifyValue = "null"
        ElseIf TypeName(v) = "Collection" Then
            StringifyValue = StringifyArray(v)
        ElseIf TypeName(v) = "Dictionary" Then
            StringifyValue = StringifyObject(v)
        Else
            ' Unknown object: best effort as an array via its default enumerator.
            StringifyValue = StringifyUnknown(v)
        End If
    ElseIf IsArray(v) Then
        StringifyValue = StringifyVBArray(v)
    ElseIf VarType(v) = vbBoolean Then
        If v Then StringifyValue = "true" Else StringifyValue = "false"
    ElseIf VarType(v) = vbString Then
        StringifyValue = EscapeString(CStr(v))
    ElseIf IsNumeric(v) Then
        StringifyValue = NumToJson(v)
    Else
        StringifyValue = EscapeString(CStr(v))
    End If
End Function

Private Function StringifyObject(ByVal d As Object) As String
    Dim out As String
    Dim keys As Variant
    Dim i As Long
    If d.Count = 0 Then
        StringifyObject = "{}"
        Exit Function
    End If
    out = "{"
    keys = d.Keys
    For i = LBound(keys) To UBound(keys)
        If i > LBound(keys) Then out = out & ","
        out = out & EscapeString(CStr(keys(i))) & ":"
        out = out & JsonStringify(DictItem(d, keys(i)))
    Next i
    out = out & "}"
    StringifyObject = out
End Function

' Return a Dictionary item as a Variant, preserving object references.
Private Function DictItem(ByVal d As Object, ByVal key As Variant) As Variant
    If IsObject(d.Item(key)) Then
        Set DictItem = d.Item(key)
    Else
        DictItem = d.Item(key)
    End If
End Function

Private Function StringifyArray(ByVal col As Object) As String
    Dim out As String
    Dim i As Long
    out = "["
    For i = 1 To col.Count
        If i > 1 Then out = out & ","
        out = out & JsonStringify(ColItem(col, i))
    Next i
    out = out & "]"
    StringifyArray = out
End Function

' Return a Collection item as a Variant, preserving object references.
Private Function ColItem(ByVal col As Object, ByVal index As Long) As Variant
    If IsObject(col.Item(index)) Then
        Set ColItem = col.Item(index)
    Else
        ColItem = col.Item(index)
    End If
End Function

Private Function StringifyUnknown(ByVal obj As Object) As String
    Dim out As String
    Dim itm As Variant
    out = "["
    On Error Resume Next
    For Each itm In obj
        If Len(out) > 1 Then out = out & ","
        out = out & JsonStringify(itm)
    Next itm
    On Error GoTo 0
    out = out & "]"
    StringifyUnknown = out
End Function

Private Function StringifyVBArray(ByVal arr As Variant) As String
    Dim out As String
    Dim i As Long
    out = "["
    On Error Resume Next
    For i = LBound(arr) To UBound(arr)
        If i > LBound(arr) Then out = out & ","
        out = out & JsonStringify(arr(i))
    Next i
    On Error GoTo 0
    out = out & "]"
    StringifyVBArray = out
End Function

Private Function EscapeString(ByVal s As String) As String
    Dim out As String
    Dim i As Long
    Dim c As String
    Dim code As Long
    out = """"
    For i = 1 To Len(s)
        c = Mid$(s, i, 1)
        code = AscW(c)
        If code < 0 Then code = code + 65536
        Select Case c
            Case """": out = out & "\"""
            Case "\": out = out & "\\"
            Case vbCr: out = out & "\r"
            Case vbLf: out = out & "\n"
            Case vbTab: out = out & "\t"
            Case Chr$(8): out = out & "\b"
            Case Chr$(12): out = out & "\f"
            Case Else
                If code < 32 Then
                    out = out & "\u" & Hex4(code)
                ElseIf code < 127 Then
                    out = out & c
                Else
                    ' Non-ASCII is emitted as \uXXXX: valid JSON, pure ASCII on
                    ' the wire, and round-trips through any HTTP encoding.
                    out = out & "\u" & Hex4(code)
                End If
        End Select
    Next i
    out = out & """"
    EscapeString = out
End Function

Private Function NumToJson(ByVal v As Variant) As String
    Dim d As Double
    Dim decSep As String
    Dim s As String
    d = CDbl(v)
    decSep = Mid$(CStr(1.5), 2, 1)
    If d = Int(d) And d >= -2147483648# And d <= 2147483647# Then
        NumToJson = CStr(CLng(d))
    Else
        s = CStr(d)
        If decSep <> "." Then s = Replace(s, decSep, ".")
        NumToJson = s
    End If
End Function

Private Function Hex4(ByVal v As Long) As String
    Dim h As String
    h = Hex$(v)
    Do While Len(h) < 4
        h = "0" & h
    Loop
    Hex4 = h
End Function
