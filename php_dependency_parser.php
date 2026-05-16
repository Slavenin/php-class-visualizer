<?php
// php_dependency_parser.php

class PHPDependencyParser
{
    // Стандартные классы PHP (неполный список, можно расширить)
    private const PHP_NATIVE_CLASSES = [
        'datetime', 'datetimeimmutable', 'dateinterval', 'dateperiod',
        'exception', 'errorexception', 'runtimeexception', 'invalidargumentexception',
        'arrayobject', 'arrayiterator', 'recursivearrayiterator',
        'splfileinfo', 'splfileobject', 'recursivedirectoryiterator',
        'pdo', 'pdostatement', 'mysqli', 'sqlite3',
        'stdclass', 'closure', 'generator', 'fiber',
        'reflectionclass', 'reflectionmethod', 'reflectionfunction',
        'domdocument', 'domxpath', 'simplexmlelement',
        'soapclient', 'soapserver',
        'ziparchive',
        'curlfile', 'curlhandle',
        'gdimage', 'imagick', 'imagickpixel',
        'memcached', 'redis',
        'mongodb\client', 'mongodb\collection',
        // Symfony часто использует эти, но они не нативные, поэтому не включаем
    ];

    private bool $includeNative = false; // по умолчанию исключаем
    private string $rootDir;
    private array $classes = [];
    private array $dependencies = [];
    private array $namespaces = [];
    private array $files = [];

    private array $excludePatterns = [];
    private array $includeOnlyPatterns = [];
    private ?string $scanSubdirectory = null;
    private array $excludeDirs = ['vendor', 'node_modules', '.git', 'var', 'cache'];
    private array $options = [];

    public function __construct(string $rootDir, array $options = [])
    {
        $this->rootDir = realpath($rootDir);

        $this->excludePatterns = $options['exclude'] ?? [];
        $this->includeOnlyPatterns = $options['include_only'] ?? [];
        $this->scanSubdirectory = $options['subdirectory'] ?? null;
        $this->includeNative = $options['include_native'] ?? false;

        if (isset($options['exclude_dirs'])) {
            $this->excludeDirs = array_merge($this->excludeDirs, $options['exclude_dirs']);
        }
        $this->options = $options;
    }

    public function parse(): array
    {
        $this->scanDirectory($this->getScanDirectory());
        $this->analyzeDependencies();

        // Добавляем внешние классы, если не запрещено
        if (!($this->options['exclude_external'] ?? false)) {
            $this->addExternalClasses();
        }

        return [
            'classes' => $this->classes,
            'dependencies' => $this->dependencies,
            'namespaces' => $this->namespaces,
            'files' => $this->files,
            'statistics' => $this->calculateStatistics(),
            'config' => [
                'exclude_patterns' => $this->excludePatterns,
                'include_only_patterns' => $this->includeOnlyPatterns,
                'scan_subdirectory' => $this->scanSubdirectory,
                'exclude_dirs' => $this->excludeDirs,
                'exclude_external' => $this->options['exclude_external'] ?? false
            ]
        ];
    }

    private function addExternalClasses(): void
    {
        foreach ($this->dependencies as $dep) {
            $to = $dep['to'];
            if (!isset($this->classes[$to])) {
                $parts = explode('\\', $to);
                $shortName = end($parts);
                $namespace = count($parts) > 1 ? implode('\\', array_slice($parts, 0, -1)) : null;

                $this->classes[$to] = [
                    'name' => $to,
                    'shortName' => $shortName,
                    'namespace' => $namespace,
                    'file' => null,
                    'type' => 'external',
                    'size' => 0,
                    'complexity' => 0,
                    'lines' => 0,
                    'methods' => 0,
                ];

                // Добавляем в иерархию пространств имён
                if ($namespace) {
                    $parts = explode('\\', $namespace);
                    $currentPath = '';
                    foreach ($parts as $part) {
                        $currentPath .= ($currentPath ? '\\' : '') . $part;
                        if (!isset($this->namespaces[$currentPath])) {
                            $this->namespaces[$currentPath] = [
                                'name' => $currentPath,
                                'classes' => [],
                                'sub_namespaces' => []
                            ];
                        }
                        $this->namespaces[$currentPath]['classes'][] = $to;
                    }
                }
            }
        }
    }

    private function getScanDirectory(): string
    {
        if ($this->scanSubdirectory) {
            $fullPath = $this->rootDir . '/' . ltrim($this->scanSubdirectory, '/');
            if (!is_dir($fullPath)) {
                throw new RuntimeException("Subdirectory not found: {$this->scanSubdirectory}");
            }
            return $fullPath;
        }
        return $this->rootDir;
    }

    private function scanDirectory(string $dir): void
    {
        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($dir, RecursiveDirectoryIterator::SKIP_DOTS)
        );

        foreach ($iterator as $file) {
            if ($file->getExtension() === 'php') {
                $filePath = $file->getPathname();

                if ($this->isExcludedDirectory($filePath)) {
                    continue;
                }

                if ($this->isExcludedFile($filePath)) {
                    continue;
                }

                if (!$this->isIncludedFile($filePath)) {
                    continue;
                }

                $this->analyzeFile($filePath);
            }
        }
    }

    private function isExcludedDirectory(string $filePath): bool
    {
        $relativePath = str_replace($this->rootDir . '/', '', $filePath);
        $parts = explode('/', $relativePath);

        foreach ($parts as $part) {
            if (in_array($part, $this->excludeDirs)) {
                return true;
            }
        }

        return false;
    }

    private function isExcludedFile(string $filePath): bool
    {
        if (empty($this->excludePatterns)) {
            return false;
        }

        $fileName = basename($filePath);
        $relativePath = str_replace($this->rootDir . '/', '', $filePath);

        foreach ($this->excludePatterns as $pattern) {
            $regex = $this->patternToRegex($pattern);
            if (preg_match($regex, $fileName) || preg_match($regex, $relativePath)) {
                return true;
            }
        }

        return false;
    }

    private function isIncludedFile(string $filePath): bool
    {
        if (empty($this->includeOnlyPatterns)) {
            return true;
        }

        $fileName = basename($filePath);
        $relativePath = str_replace($this->rootDir . '/', '', $filePath);

        foreach ($this->includeOnlyPatterns as $pattern) {
            $regex = $this->patternToRegex($pattern);
            if (preg_match($regex, $fileName) || preg_match($regex, $relativePath)) {
                return true;
            }
        }

        return false;
    }

    private function patternToRegex(string $pattern): string
    {
        $regex = preg_quote($pattern, '/');
        $regex = str_replace('\*', '.*', $regex);
        return '/^' . $regex . '$/i';
    }

    private function analyzeFile(string $filePath): void
    {
        $content = file_get_contents($filePath);
        $relativePath = str_replace($this->rootDir . '/', '', $filePath);

        $namespace = $this->extractNamespace($content);
        $className = $this->extractClassName($content);

        if ($className) {
            $fullClassName = $namespace ? $namespace . '\\' . $className : $className;

            $this->files[$relativePath] = [
                'path' => $relativePath,
                'namespace' => $namespace,
                'class' => $fullClassName,
                'type' => $this->detectClassType($content, $className)
            ];

            $this->classes[$fullClassName] = [
                'name' => $fullClassName,
                'shortName' => $className,
                'namespace' => $namespace,
                'file' => $relativePath,
                'type' => $this->detectClassType($content, $className),
                'size' => filesize($filePath),
                'complexity' => $this->calculateComplexity($content),
                'lines' => substr_count($content, "\n"),
                'methods' => preg_match_all('/function\s+\w+/i', $content)
            ];

            if ($namespace) {
                $parts = explode('\\', $namespace);
                $currentPath = '';
                foreach ($parts as $part) {
                    $currentPath .= ($currentPath ? '\\' : '') . $part;
                    if (!isset($this->namespaces[$currentPath])) {
                        $this->namespaces[$currentPath] = [
                            'name' => $currentPath,
                            'classes' => [],
                            'sub_namespaces' => []
                        ];
                    }
                    $this->namespaces[$currentPath]['classes'][] = $fullClassName;
                }
            }

            $this->extractDependencies($content, $fullClassName, $filePath);
        }
    }

    private function extractNamespace(string $content): ?string
    {
        if (preg_match('/namespace\s+([^;]+);/i', $content, $matches)) {
            return trim($matches[1]);
        }
        return null;
    }

    private function extractClassName(string $content): ?string
    {
        if (preg_match('/(?:class|interface|trait)\s+(\w+)/i', $content, $matches)) {
            return $matches[1];
        }
        return null;
    }

    private function detectClassType(string $content, string $className): string
    {
        if (preg_match('/interface\s+' . $className . '/i', $content)) {
            return 'interface';
        } elseif (preg_match('/trait\s+' . $className . '/i', $content)) {
            return 'trait';
        } elseif (preg_match('/abstract\s+class\s+' . $className . '/i', $content)) {
            return 'abstract_class';
        } else {
            return 'class';
        }
    }

    private function extractDependencies(string $content, string $className, string $filePath): void
    {
        // Use statements
        preg_match_all('/use\s+([^;]+);/i', $content, $useMatches);
        foreach ($useMatches[1] as $useStatement) {
            $useStatement = preg_replace('/\s+as\s+.+$/i', '', $useStatement);
            $useStatement = trim($useStatement);
            if ($useStatement !== $className && $this->isRelevantClass($useStatement)) {
                $this->addDependency($className, $useStatement, 'use', $filePath);
            }
        }

        // Extends
        if (preg_match('/extends\s+([^\s{]+)/i', $content, $extendsMatch)) {
            $parentClass = $this->resolveClassName($extendsMatch[1], $content);
            if ($parentClass !== $className && $this->isRelevantClass($parentClass)) {
                $this->addDependency($className, $parentClass, 'extends', $filePath);
            }
        }

        // Implements
        if (preg_match('/implements\s+([^{]+)/i', $content, $implementsMatch)) {
            $interfaces = explode(',', $implementsMatch[1]);
            foreach ($interfaces as $interface) {
                $interface = $this->resolveClassName(trim($interface), $content);
                if ($interface !== $className && $this->isRelevantClass($interface)) {
                    $this->addDependency($className, $interface, 'implements', $filePath);
                }
            }
        }

        // Type hints in methods
        preg_match_all('/function\s+\w+\s*\([^)]*\)/i', $content, $methodMatches);
        foreach ($methodMatches[0] as $methodSignature) {
            preg_match_all('/[\w\\\\]+(?=\s+\$\w+)/i', $methodSignature, $typeHints);
            foreach ($typeHints[0] as $typeHint) {
                if (!in_array(strtolower($typeHint), ['int', 'string', 'array', 'bool', 'float', 'void', 'null', 'mixed', 'callable', 'self', 'static'])) {
                    $resolvedType = $this->resolveClassName($typeHint, $content);
                    if ($resolvedType !== $className && $this->isRelevantClass($resolvedType)) {
                        $this->addDependency($className, $resolvedType, 'parameter_type', $filePath);
                    }
                }
            }
        }

        // Return types
        preg_match_all('/function\s+\w+\s*\([^)]*\)\s*:\s*([^\s{]+)/i', $content, $returnTypes);
        foreach ($returnTypes[1] as $returnType) {
            if (!in_array(strtolower($returnType), ['int', 'string', 'array', 'bool', 'float', 'void', 'null', 'mixed', 'callable', 'self', 'static'])) {
                $resolvedType = $this->resolveClassName($returnType, $content);
                if ($resolvedType !== $className && $this->isRelevantClass($resolvedType)) {
                    $this->addDependency($className, $resolvedType, 'return_type', $filePath);
                }
            }
        }
    }

    private function isRelevantClass(string $fullClassName): bool
    {
        if ($this->includeNative) {
            return true;
        }
        $lower = strtolower($fullClassName);
        // Игнорируем, если начинается с '\' (глобальное пространство)
        $lower = ltrim($lower, '\\');
        // Проверяем точное совпадение с базой нативных классов
        return !in_array($lower, self::PHP_NATIVE_CLASSES);
    }

    private function resolveClassName(string $className, string $content): string
    {
        $className = trim($className, '\\');

        // Check for use statements
        preg_match('/use\s+([^;]*' . preg_quote($className, '/') . '[^;]*);/i', $content, $useMatch);
        if ($useMatch) {
            $fullUse = trim($useMatch[1]);
            $fullUse = preg_replace('/\s+as\s+.+$/i', '', $fullUse);
            return trim($fullUse);
        }

        if (strpos($className, '\\') === 0) {
            return substr($className, 1);
        }

        $namespace = $this->extractNamespace($content);
        if ($namespace && strpos($className, '\\') !== false) {
            return $namespace . '\\' . $className;
        }

        return $className;
    }

    private function addDependency(string $from, string $to, string $type, string $filePath): void
    {
        $key = $from . '->' . $to;

        if (!isset($this->dependencies[$key])) {
            $this->dependencies[$key] = [
                'from' => $from,
                'to' => $to,
                'types' => [],
                'files' => []
            ];
        }

        if (!in_array($type, $this->dependencies[$key]['types'])) {
            $this->dependencies[$key]['types'][] = $type;
        }

        if (!in_array($filePath, $this->dependencies[$key]['files'])) {
            $this->dependencies[$key]['files'][] = $filePath;
        }
    }

    private function calculateComplexity(string $content): int
    {
        $complexity = 0;

        // Count methods
        $complexity += preg_match_all('/function\s+\w+/i', $content);

        // Count conditionals
        $complexity += preg_match_all('/\b(if|else\s*if|for|foreach|while|case)\b/i', $content);

        // Count logical operators
        $complexity += preg_match_all('/\b(&&|\|\|)\b/', $content);

        return $complexity;
    }

    private function analyzeDependencies(): void
    {
        $grouped = [];
        foreach ($this->dependencies as $dep) {
            $fromNs = $this->classes[$dep['from']]['namespace'] ?? 'global';
            $toNs = $this->classes[$dep['to']]['namespace'] ?? 'global';

            $nsKey = $fromNs . '->' . $toNs;
            if (!isset($grouped[$nsKey])) {
                $grouped[$nsKey] = [
                    'from_namespace' => $fromNs,
                    'to_namespace' => $toNs,
                    'count' => 0,
                    'dependencies' => []
                ];
            }
            $grouped[$nsKey]['count']++;
            $grouped[$nsKey]['dependencies'][] = $dep;
        }

        $this->namespaceDependencies = $grouped;
    }

    private function calculateStatistics(): array
    {
        $totalClasses = count($this->classes);
        $totalDependencies = count($this->dependencies);
        $totalNamespaces = count($this->namespaces);
        $totalFiles = count($this->files);

        $dependencyCount = [];
        $dependencyFromCount = [];

        foreach ($this->dependencies as $dep) {
            $dependencyCount[$dep['to']] = ($dependencyCount[$dep['to']] ?? 0) + 1;
            $dependencyFromCount[$dep['from']] = ($dependencyFromCount[$dep['from']] ?? 0) + 1;
        }

        arsort($dependencyCount);
        arsort($dependencyFromCount);

        $mostUsed = array_slice($dependencyCount, 0, 20, true);
        $mostDependent = array_slice($dependencyFromCount, 0, 20, true);

        $typeStats = [];
        foreach ($this->classes as $class) {
            $type = $class['type'];
            $typeStats[$type] = ($typeStats[$type] ?? 0) + 1;
        }

        $sizeDistribution = [
            'small' => 0,
            'medium' => 0,
            'large' => 0,
            'huge' => 0
        ];

        foreach ($this->classes as $class) {
            $sizeKB = $class['size'] / 1024;
            if ($sizeKB < 5) $sizeDistribution['small']++;
            elseif ($sizeKB < 50) $sizeDistribution['medium']++;
            elseif ($sizeKB < 200) $sizeDistribution['large']++;
            else $sizeDistribution['huge']++;
        }

        return [
            'total_classes' => $totalClasses,
            'total_dependencies' => $totalDependencies,
            'total_namespaces' => $totalNamespaces,
            'total_files' => $totalFiles,
            'most_used_classes' => $mostUsed,
            'most_dependent_classes' => $mostDependent,
            'class_types' => $typeStats,
            'size_distribution' => $sizeDistribution,
            'average_dependencies_per_class' => $totalClasses > 0 ? round($totalDependencies / $totalClasses, 2) : 0,
            'filtered' => [
                'exclude_patterns' => $this->excludePatterns,
                'include_only_patterns' => $this->includeOnlyPatterns,
                'scan_subdirectory' => $this->scanSubdirectory
            ]
        ];
    }

    public function exportToJSON(string $outputFile): void
    {
        $data = $this->parse();
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        if ($json === false) {
            throw new RuntimeException('Failed to encode JSON: ' . json_last_error_msg());
        }

        $dir = dirname($outputFile);
        if (!is_dir($dir)) {
            mkdir($dir, 0755, true);
        }

        file_put_contents($outputFile, $json);
    }

    public function exportToGephi(string $nodesFile, string $edgesFile): void
    {
        $data = $this->parse();

        // Ensure directories exist
        $nodesDir = dirname($nodesFile);
        $edgesDir = dirname($edgesFile);
        if (!is_dir($nodesDir)) mkdir($nodesDir, 0755, true);
        if (!is_dir($edgesDir)) mkdir($edgesDir, 0755, true);

        // Export nodes
        $nodesHandle = fopen($nodesFile, 'w');
        fputcsv($nodesHandle, ['Id', 'Label', 'Type', 'Namespace', 'Size', 'Complexity', 'Lines', 'Methods']);

        foreach ($data['classes'] as $className => $classInfo) {
            fputcsv($nodesHandle, [
                $className,
                $classInfo['shortName'],
                $classInfo['type'],
                $classInfo['namespace'] ?? '',
                $classInfo['size'],
                $classInfo['complexity'],
                $classInfo['lines'] ?? 0,
                $classInfo['methods'] ?? 0
            ]);
        }
        fclose($nodesHandle);

        // Export edges
        $edgesHandle = fopen($edgesFile, 'w');
        fputcsv($edgesHandle, ['Source', 'Target', 'Type', 'Weight', 'Files']);

        foreach ($data['dependencies'] as $dep) {
            fputcsv($edgesHandle, [
                $dep['from'],
                $dep['to'],
                implode('|', $dep['types']),
                count($dep['files']),
                implode(';', $dep['files'])
            ]);
        }
        fclose($edgesHandle);
    }
}

// CLI interface
if (PHP_SAPI === 'cli') {
    $options = getopt('d:o:s:e:i:h', [
        'dir:',
        'output:',
        'format:',
        'subdirectory:',
        'exclude:',
        'include-only:',
        'exclude-dirs:',
        'include-native:',
        'help',
        'exclude-external'
    ]);

    if (isset($options['help']) || isset($options['h'])) {
        echo "PHP Dependency Parser with Filtering\n\n";
        echo "Usage: php php_dependency_parser.php [options]\n\n";
        echo "Required:\n";
        echo "  -d, --dir <path>           Directory to parse\n\n";
        echo "Optional:\n";
        echo "  -o, --output <prefix>      Output file prefix (default: dependencies)\n";
        echo "  --format <json|gephi>      Output format (default: json)\n";
        echo "  -s, --subdirectory <path>  Scan only specific subdirectory\n";
        echo "  -e, --exclude <pattern>    Exclude files matching pattern (repeatable)\n";
        echo "  -i, --include-only <pat>   Include only files matching pattern (repeatable)\n";
        echo "  --exclude-dirs <dirs>      Additional dirs to exclude (comma-separated)\n";
        echo "  --include-native           \n";
        echo "  -h, --help                 This help\n\n";
        echo "Pattern examples:\n";
        echo "  *Test*                     Exclude all files with 'Test' in name\n";
        echo "  *Controller.php            Only include Controllers\n";
        echo "  src/Controller/*           Only files in Controller directory\n\n";
        echo "Examples:\n";
        echo "  # Parse only src/ directory, exclude tests\n";
        echo "  php parser.php -d /project -s src -e *Test* -e *test*\n\n";
        echo "  # Parse only Controllers\n";
        echo "  php parser.php -d /project -i *Controller.php\n\n";
        echo "  # Exclude vendor and tests, scan only App namespace\n";
        echo "  php parser.php -d /project -s src/App -e *Test* --exclude-dirs var,node_modules\n";
        exit(0);
    }

    $dir = $options['d'] ?? $options['dir'] ?? null;
    $output = $options['o'] ?? $options['output'] ?? 'dependencies';
    $format = $options['format'] ?? 'json';

    if (!$dir || !is_dir($dir)) {
        die("Error: Directory not specified or doesn't exist\n");
    }

    if (isset($options['include-native'])) {
        $parserOptions['include_native'] = true;
    }

    // Collect filter options
    $parserOptions = [];

    if (isset($options['s']) || isset($options['subdirectory'])) {
        $parserOptions['subdirectory'] = $options['s'] ?? $options['subdirectory'];
    }

    if (isset($options['e']) || isset($options['exclude'])) {
        $excludes = isset($options['e']) ? (array)$options['e'] : (array)$options['exclude'];
        $parserOptions['exclude'] = $excludes;
    }

    if (isset($options['i']) || isset($options['include-only'])) {
        $includes = isset($options['i']) ? (array)$options['i'] : (array)$options['include-only'];
        $parserOptions['include_only'] = $includes;
    }

    if (isset($options['exclude-dirs'])) {
        $parserOptions['exclude_dirs'] = explode(',', $options['exclude-dirs']);
    }

    $parserOptions['exclude_external'] = isset($options['exclude-external']);

    echo "PHP Dependency Parser\n";
    echo "=====================\n";
    echo "Directory: $dir\n";
    if ($parserOptions['subdirectory'] ?? null) {
        echo "Subdirectory: {$parserOptions['subdirectory']}\n";
    }
    if (!empty($parserOptions['exclude'])) {
        echo "Exclude patterns: " . implode(', ', $parserOptions['exclude']) . "\n";
    }
    if (!empty($parserOptions['include_only'])) {
        echo "Include only: " . implode(', ', $parserOptions['include_only']) . "\n";
    }
    echo "\n";

    try {
        $parser = new PHPDependencyParser($dir, $parserOptions);

        switch ($format) {
            case 'gephi':
                $nodesFile = $output . '_nodes.csv';
                $edgesFile = $output . '_edges.csv';
                $parser->exportToGephi($nodesFile, $edgesFile);
                echo "Gephi files created:\n";
                echo "  Nodes: $nodesFile\n";
                echo "  Edges: $edgesFile\n";
                break;

            case 'json':
            default:
                $jsonFile = $output . '.json';
                $parser->exportToJSON($jsonFile);
                echo "JSON file created: $jsonFile\n";
                break;
        }

        $stats = $parser->parse()['statistics'];
        echo "\nStatistics:\n";
        echo "  Classes: {$stats['total_classes']}\n";
        echo "  Dependencies: {$stats['total_dependencies']}\n";
        echo "  Namespaces: {$stats['total_namespaces']}\n";
        echo "  Files: {$stats['total_files']}\n";
        echo "  Avg deps per class: {$stats['average_dependencies_per_class']}\n";

        if (!empty($stats['class_types'])) {
            echo "\nClass Types:\n";
            foreach ($stats['class_types'] as $type => $count) {
                echo "  $type: $count\n";
            }
        }

        if (!empty($stats['most_used_classes'])) {
            echo "\nTop 5 Most Used Classes:\n";
            $i = 0;
            foreach ($stats['most_used_classes'] as $class => $count) {
                if ($i++ >= 5) break;
                echo "  $class: $count dependencies\n";
            }
        }

        if (!empty($stats['size_distribution'])) {
            echo "\nFile Size Distribution:\n";
            foreach ($stats['size_distribution'] as $size => $count) {
                echo "  $size: $count files\n";
            }
        }

    } catch (Exception $e) {
        die("Error: " . $e->getMessage() . "\n");
    }
}